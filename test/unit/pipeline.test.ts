import type { JsonValue } from '@revisium/revo-pipeline';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  sleepms: vi.fn<(duration: number) => Promise<void>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    runStep: <Result>(operation: () => Promise<Result>) => operation(),
    sleepms: dbos.sleepms,
  },
}));

import {
  candidateExecutionId,
  interpretExecutionPlan,
  RunInterpretationError,
  taskExecutionId,
} from '../../src/pipeline/interpret-pipeline.js';
import type { ExecutionPlan, ExecutionResult, RunExecutor } from '../../src/types.js';
import {
  candidateExecutionPlan,
  scriptExecutionPlan,
  sequentialTaskExecutionPlan,
  taskExecutionPlan,
} from '../support/execution-plan.js';

const executor = (overrides: Partial<RunExecutor> = {}) => {
  const cancel = vi.fn<RunExecutor['cancel']>(async () => ({ status: 'not_supported' }));
  const execute = vi.fn<RunExecutor['execute']>(async (invocation) => ({
    completion:
      invocation.kind === 'candidate'
        ? { kind: 'candidate', verdict: 'approve' }
        : { kind: 'task' },
    status: 'completed',
  }));
  const reconcile = vi.fn<RunExecutor['reconcile']>(async () => ({ status: 'not_found' }));
  return {
    execute,
    reconcile,
    value: {
      cancel: overrides.cancel ?? cancel,
      execute: overrides.execute ?? execute,
      reconcile: overrides.reconcile ?? reconcile,
    } satisfies RunExecutor,
  };
};

beforeEach(() => {
  dbos.sleepms.mockClear();
});

const recoverMalformedTaskCompletion = async (completion: unknown) => {
  const reconcile = vi
    .fn<RunExecutor['reconcile']>()
    .mockResolvedValueOnce({ status: 'not_found' })
    .mockResolvedValueOnce({
      status: 'completed',
      completion: { kind: 'task', output: { adopted: true } },
    });
  const malformed: ExecutionResult = { completion: { kind: 'task' }, status: 'completed' };
  Reflect.set(malformed, 'completion', completion);
  const execute = vi.fn<RunExecutor['execute']>(async () => malformed);
  const runExecutor = executor({ execute, reconcile });

  const result = await interpretExecutionPlan('run-id', taskExecutionPlan, null, runExecutor.value);

  expect(result).toEqual({
    kind: 'revo-run.terminal.v1',
    result: {
      outcome: 'succeeded',
      outputs: [{ nodeKey: 'task', value: { adopted: true } }],
    },
    status: 'succeeded',
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]?.[0]).toBe(reconcile.mock.calls[1]?.[0]);
  expect(dbos.sleepms).toHaveBeenCalledWith(100);
};

describe('generic execution-plan interpretation', () => {
  it('frames deterministic task and candidate execution IDs without tuple collisions', () => {
    expect(taskExecutionId('a', 'bc')).not.toBe(taskExecutionId('ab', 'c'));
    expect(candidateExecutionId('run', 'a', 'bc')).not.toBe(candidateExecutionId('run', 'ab', 'c'));
    expect(candidateExecutionId('run', 'node', 'candidate')).toBe(
      candidateExecutionId('run', 'node', 'candidate'),
    );
  });

  it('reconciles first and executes a plain task with the run input only when not found', async () => {
    const runExecutor = executor();

    await expect(
      interpretExecutionPlan('run-id', taskExecutionPlan, { source: 'run' }, runExecutor.value),
    ).resolves.toEqual({
      kind: 'revo-run.terminal.v1',
      result: { outcome: 'succeeded' },
      status: 'succeeded',
    });

    expect(runExecutor.reconcile).toHaveBeenCalledOnce();
    expect(runExecutor.execute).toHaveBeenCalledOnce();
    const invocation = runExecutor.execute.mock.calls[0]?.[0];
    expect(invocation).toMatchObject({
      executionId: taskExecutionId('run-id', 'task'),
      input: { source: 'run' },
      kind: 'task',
      nodeKey: 'task',
      runId: 'run-id',
    });
    expect(invocation).not.toHaveProperty('script');
  });

  it('preserves scalar and nested task outputs in actual completion order without duplicates', async () => {
    const source = { nested: [{ value: 1 }] };
    const runExecutor = executor({
      execute: vi.fn<RunExecutor['execute']>(async (invocation) => ({
        completion: {
          kind: 'task',
          output: invocation.nodeKey === 'first' ? source : 42,
        },
        status: 'completed',
      })),
    });

    const result = await interpretExecutionPlan(
      'run-id',
      sequentialTaskExecutionPlan,
      null,
      runExecutor.value,
    );
    source.nested[0]!.value = 2;

    expect(result).toEqual({
      kind: 'revo-run.terminal.v1',
      result: {
        outcome: 'published',
        outputs: [
          { nodeKey: 'first', value: { nested: [{ value: 1 }] } },
          { nodeKey: 'second', value: 42 },
        ],
      },
      status: 'succeeded',
    });
    const nodeKeys =
      result.status === 'succeeded' && 'outputs' in result.result
        ? result.result.outputs.map(({ nodeKey }) => nodeKey)
        : [];
    expect(new Set(nodeKeys).size).toBe(2);
  });

  it('adopts a reconciled task output without executing and keeps the execution ID stable', async () => {
    const reconcile = vi.fn<RunExecutor['reconcile']>(async () => ({
      completion: { kind: 'task', output: 'reconciled' },
      status: 'completed',
    }));
    const runExecutor = executor({ reconcile });

    await expect(
      interpretExecutionPlan('run-id', taskExecutionPlan, null, runExecutor.value),
    ).resolves.toMatchObject({
      result: { outputs: [{ nodeKey: 'task', value: 'reconciled' }] },
      status: 'succeeded',
    });

    expect(runExecutor.execute).not.toHaveBeenCalled();
    expect(reconcile.mock.calls[0]?.[0].executionId).toBe(taskExecutionId('run-id', 'task'));
  });

  it('uses a matching script requirement and preserves its static null input', async () => {
    const runExecutor = executor();

    await interpretExecutionPlan(
      'run-id',
      scriptExecutionPlan,
      { source: 'run' },
      runExecutor.value,
    );

    expect(runExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: null,
        kind: 'task',
        nodeKey: 'script',
        script: { id: 'script:test/example', version: 1 },
      }),
    );
  });

  it('rejects duplicate and foreign requirements before external dispatch', async () => {
    const duplicate = {
      ...scriptExecutionPlan,
      executorRequirements: [
        ...scriptExecutionPlan.executorRequirements,
        ...scriptExecutionPlan.executorRequirements,
      ],
    } satisfies ExecutionPlan;
    const foreign = {
      ...taskExecutionPlan,
      executorRequirements: [
        {
          input: null,
          kind: 'script',
          nodeKey: 'foreign',
          script: { id: 'script:test/foreign', version: 1 },
        },
      ],
    } satisfies ExecutionPlan;

    for (const plan of [duplicate, foreign]) {
      const runExecutor = executor();
      // oxlint-disable-next-line no-await-in-loop -- each invalid plan is independently asserted
      await expect(
        interpretExecutionPlan('run-id', plan, null, runExecutor.value),
      ).rejects.toMatchObject({ code: 'invalid_workflow_state' });
      expect(runExecutor.reconcile).not.toHaveBeenCalled();
      expect(runExecutor.execute).not.toHaveBeenCalled();
    }
  });

  it('durably sleeps after a running checkpoint and never executes after a known outcome', async () => {
    const reconcile = vi
      .fn<RunExecutor['reconcile']>()
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'completed', completion: { kind: 'task' } });
    const runExecutor = executor({ reconcile });

    await interpretExecutionPlan('run-id', taskExecutionPlan, null, runExecutor.value);

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(runExecutor.execute).not.toHaveBeenCalled();
    expect(dbos.sleepms).toHaveBeenCalledWith(100);
  });

  it('sleeps and reconciles again after an unknown reconciliation outcome', async () => {
    const reconcile = vi
      .fn<RunExecutor['reconcile']>()
      .mockResolvedValueOnce({ status: 'outcome_unknown' })
      .mockResolvedValueOnce({ status: 'completed', completion: { kind: 'task' } });
    const runExecutor = executor({ reconcile });

    await interpretExecutionPlan('run-id', taskExecutionPlan, null, runExecutor.value);

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(runExecutor.execute).not.toHaveBeenCalled();
    expect(dbos.sleepms).toHaveBeenCalledWith(100);
  });

  it('reconciles an unknown execute outcome without repeating the effect', async () => {
    const execute = vi.fn<RunExecutor['execute']>(async () => ({ status: 'outcome_unknown' }));
    const reconcile = vi
      .fn<RunExecutor['reconcile']>()
      .mockResolvedValueOnce({ status: 'not_found' })
      .mockResolvedValueOnce({ status: 'completed', completion: { kind: 'task' } });
    const runExecutor = executor({ execute, reconcile });

    await interpretExecutionPlan('run-id', taskExecutionPlan, null, runExecutor.value);

    expect(execute).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toBe(reconcile.mock.calls[1]?.[0]);
    expect(execute.mock.calls[0]?.[0].executionId).toBe(taskExecutionId('run-id', 'task'));
    expect(dbos.sleepms).toHaveBeenCalledWith(100);
  });

  it.each([
    ['task verdict', { kind: 'task', verdict: 'approve' }],
    ['candidate output', { kind: 'candidate', output: null, verdict: 'approve' }],
    ['explicit undefined output', { kind: 'task', output: undefined }],
    ['non-finite output', { kind: 'task', output: Number.NaN }],
    ['function output', { kind: 'task', output: () => true }],
    ['symbol output', { kind: 'task', output: Symbol('output') }],
    ['bigint output', { kind: 'task', output: 1n }],
    [
      'class output',
      {
        kind: 'task',
        output: new (class Output {
          readonly value = true;
        })(),
      },
    ],
    [
      'sparse array output',
      { kind: 'task', output: Object.assign(new Array<unknown>(2), { 0: 'present' }) },
    ],
    ['augmented array output', { kind: 'task', output: Object.assign([1], { extra: true }) }],
  ])('normalizes a malformed %s to outcome_unknown', async (_name, completion) => {
    expect.hasAssertions();
    await recoverMalformedTaskCompletion(completion);
  });

  it('rejects cyclic output without repeating execute', async () => {
    expect.hasAssertions();
    const output: { cycle?: unknown } = {};
    output.cycle = output;

    await recoverMalformedTaskCompletion({ kind: 'task', output });
  });

  it('rejects accessors and non-enumerable output without invoking getters', async () => {
    let getterCalls = 0;
    const accessorOutput = {};
    Object.defineProperty(accessorOutput, 'value', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'secret';
      },
    });
    await recoverMalformedTaskCompletion({ kind: 'task', output: accessorOutput });
    expect(getterCalls).toBe(0);

    const hiddenOutput = {};
    Object.defineProperty(hiddenOutput, 'value', { enumerable: false, value: 'hidden' });
    await recoverMalformedTaskCompletion({ kind: 'task', output: hiddenOutput });
  });

  it('preserves special own string keys without prototype mutation', async () => {
    const output: Record<string, JsonValue> = { constructor: 'own' };
    Object.defineProperty(output, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { safe: true },
      writable: true,
    });
    const runExecutor = executor({
      execute: vi.fn<RunExecutor['execute']>(async () => ({
        completion: { kind: 'task', output },
        status: 'completed',
      })),
    });

    const result = await interpretExecutionPlan(
      'run-id',
      taskExecutionPlan,
      null,
      runExecutor.value,
    );
    const captured =
      result.status === 'succeeded' && 'outputs' in result.result
        ? result.result.outputs[0]?.value
        : undefined;

    expect(captured).toEqual({ constructor: 'own', ['__proto__']: { safe: true } });
    if (typeof captured !== 'object' || captured === null) {
      throw new Error('Captured task output is not an object.');
    }
    expect(Object.hasOwn(captured, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(captured)).toBe(Object.prototype);
    expect(({} as { safe?: boolean }).safe).toBeUndefined();
  });

  it('rejects cross-kind completions after normalization', async () => {
    const taskExecutor = executor({
      execute: vi.fn<RunExecutor['execute']>(async () => ({
        completion: { kind: 'candidate', verdict: 'approve' },
        status: 'completed',
      })),
    });
    await expect(
      interpretExecutionPlan('run-id', taskExecutionPlan, null, taskExecutor.value),
    ).rejects.toMatchObject({ code: 'invalid_workflow_state' });

    const candidateExecutor = executor({
      execute: vi.fn<RunExecutor['execute']>(async () => ({
        completion: { kind: 'task' },
        status: 'completed',
      })),
    });
    await expect(
      interpretExecutionPlan('run-id', candidateExecutionPlan, null, candidateExecutor.value),
    ).rejects.toMatchObject({ code: 'invalid_workflow_state' });
  });

  it('treats a thrown execute as unknown and reconciles without repeating it', async () => {
    const execute = vi.fn<RunExecutor['execute']>(async () => {
      throw new Error('private provider transport failure');
    });
    const reconcile = vi
      .fn<RunExecutor['reconcile']>()
      .mockResolvedValueOnce({ status: 'not_found' })
      .mockResolvedValueOnce({ status: 'completed', completion: { kind: 'task' } });
    const runExecutor = executor({ execute, reconcile });

    await interpretExecutionPlan('run-id', taskExecutionPlan, null, runExecutor.value);

    expect(execute).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toBe(reconcile.mock.calls[1]?.[0]);
    expect(dbos.sleepms).toHaveBeenCalledWith(100);
  });

  it('records explicit candidate verdicts and never treats a failure as reject', async () => {
    const approveExecutor = executor();

    await expect(
      interpretExecutionPlan(
        'run-id',
        candidateExecutionPlan,
        { review: true },
        approveExecutor.value,
      ),
    ).resolves.toMatchObject({ status: 'succeeded' });
    expect(approveExecutor.execute).toHaveBeenCalledTimes(2);
    for (const [invocation] of approveExecutor.execute.mock.calls) {
      expect(invocation).toMatchObject({ input: { review: true }, kind: 'candidate' });
    }

    const failedExecutor = executor({
      execute: vi.fn<RunExecutor['execute']>(async () => ({
        error: { code: 'execution_failed', message: 'Candidate execution failed safely.' },
        status: 'failed',
      })),
    });
    const failure = interpretExecutionPlan(
      'failed-run',
      candidateExecutionPlan,
      null,
      failedExecutor.value,
    );
    await expect(failure).rejects.toBeInstanceOf(RunInterpretationError);
    await expect(failure).rejects.toMatchObject({ code: 'execution_failed' });
  });

  it('routes a failed task through the pure pipeline terminal contract', async () => {
    const runExecutor = executor({
      execute: vi.fn<RunExecutor['execute']>(async () => ({
        error: { code: 'execution_failed', message: 'Task execution failed safely.' },
        status: 'failed',
      })),
    });

    await expect(
      interpretExecutionPlan('run-id', taskExecutionPlan, null, runExecutor.value),
    ).resolves.toEqual({
      error: { code: 'execution_failed', message: 'Task execution failed safely.' },
      kind: 'revo-run.terminal.v1',
      status: 'failed',
    });
  });

  it('bounds a retained explicit executor failure message', async () => {
    const message = 'x'.repeat(600);
    const runExecutor = executor({
      execute: vi.fn<RunExecutor['execute']>(async () => ({
        error: { code: 'execution_failed', message },
        status: 'failed',
      })),
    });

    await expect(
      interpretExecutionPlan('run-id', taskExecutionPlan, null, runExecutor.value),
    ).resolves.toMatchObject({ error: { message: 'x'.repeat(512) }, status: 'failed' });
  });

  it('retries a thrown reconcile as an unknown observation without executing', async () => {
    const reconcile = vi
      .fn<RunExecutor['reconcile']>()
      .mockRejectedValueOnce(new Error('private provider details'))
      .mockResolvedValueOnce({ status: 'completed', completion: { kind: 'task' } });
    const runExecutor = executor({ reconcile });

    await interpretExecutionPlan('run-id', taskExecutionPlan, null, runExecutor.value);

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(runExecutor.execute).not.toHaveBeenCalled();
    expect(dbos.sleepms).toHaveBeenCalledWith(100);
  });
});
