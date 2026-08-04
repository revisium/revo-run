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
import type { ExecutionPlan, RunExecutor } from '../../src/types.js';
import {
  candidateExecutionPlan,
  scriptExecutionPlan,
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
