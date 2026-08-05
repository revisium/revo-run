import { afterEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => {
  let adoptedSubmission: { readonly status: unknown } | undefined;
  let currentWorkflowId: string | undefined;
  let failSubmission = false;
  const statuses = new Map<string, unknown>();
  const control = {
    arguments: [] as unknown[][],
    adoptNextSubmission: (status: unknown) => {
      adoptedSubmission = { status };
    },
    ids: [] as string[],
    launch: vi.fn<() => Promise<void>>(),
    registrations: [] as string[],
    results: [] as Promise<unknown>[],
    setConfig: vi.fn<(configuration: unknown) => void>(),
    shutdown: vi.fn<() => Promise<void>>(),
    sleepms: vi.fn<(duration: number) => Promise<void>>(),
    currentWorkflowId: () => currentWorkflowId,
    failNextSubmission: () => {
      failSubmission = true;
    },
    shouldFailSubmission: () => {
      const fail = failSubmission;
      failSubmission = false;
      return fail;
    },
    takeAdoptedSubmission: () => {
      const adopted = adoptedSubmission;
      adoptedSubmission = undefined;
      return adopted;
    },
    setCurrentWorkflowId: (value: string | undefined) => {
      currentWorkflowId = value;
    },
    setStatus: (id: string, value: unknown) => {
      statuses.set(id, value);
    },
    status: (id: string): unknown => statuses.get(id) ?? null,
    reset: () => {
      control.arguments.length = 0;
      control.ids.length = 0;
      control.results.length = 0;
      statuses.clear();
      adoptedSubmission = undefined;
      currentWorkflowId = undefined;
      failSubmission = false;
      control.launch.mockReset();
      control.setConfig.mockClear();
      control.shutdown.mockReset();
      control.sleepms.mockReset();
    },
  };
  return control;
});

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    get workflowID() {
      return dbos.currentWorkflowId();
    },
    getWorkflowStatus: vi.fn<(id: string) => Promise<unknown>>(async (id) => dbos.status(id)),
    launch: dbos.launch,
    registerWorkflow: <Arguments extends unknown[], Result>(
      workflow: (...arguments_: Arguments) => Promise<Result>,
      options: { name: string },
    ) => {
      dbos.registrations.push(options.name);
      return workflow;
    },
    runStep: <Result>(operation: () => Promise<Result>) => operation(),
    setConfig: dbos.setConfig,
    shutdown: dbos.shutdown,
    sleepms: dbos.sleepms,
    startWorkflow:
      <Arguments extends unknown[], Result>(
        workflow: (...arguments_: Arguments) => Promise<Result>,
        options: { workflowID?: string },
      ) =>
      async (...arguments_: Arguments) => {
        if (dbos.shouldFailSubmission()) {
          throw new Error('submission failed');
        }
        const id = options.workflowID;
        if (id === undefined) {
          throw new Error('workflow ID missing');
        }
        dbos.ids.push(id);
        dbos.arguments.push(arguments_);
        const adopted = dbos.takeAdoptedSubmission();
        if (adopted !== undefined) {
          dbos.setStatus(id, adopted.status);
          return { workflowID: id };
        }
        const now = Date.now();
        dbos.setStatus(id, {
          createdAt: now,
          input: arguments_,
          status: 'PENDING',
          workflowID: id,
          workflowName: 'revo-run.run.v2',
        });
        dbos.setCurrentWorkflowId(id);
        const result = workflow(...arguments_);
        dbos.setCurrentWorkflowId(undefined);
        dbos.results.push(result);
        void result.then(
          (output) => {
            dbos.setStatus(id, {
              createdAt: now,
              input: arguments_,
              output,
              status: 'SUCCESS',
              updatedAt: now + 1,
              workflowID: id,
              workflowName: 'revo-run.run.v2',
            });
          },
          () => {
            dbos.setStatus(id, {
              createdAt: now,
              error: new Error('private provider failure'),
              input: arguments_,
              status: 'ERROR',
              updatedAt: now + 1,
              workflowID: id,
              workflowName: 'revo-run.run.v2',
            });
          },
        );
        return { workflowID: id };
      },
  },
}));

import { createRunManager, type ExecutionPlan, type RunExecutor } from '../../src/index.js';
import {
  candidateExecutionPlan,
  sequentialTaskExecutionPlan,
  taskExecutionPlan,
} from '../support/execution-plan.js';

const executor = (): RunExecutor => ({
  cancel: vi.fn<RunExecutor['cancel']>(async () => ({ status: 'not_supported' })),
  execute: vi.fn<RunExecutor['execute']>(async () => ({
    completion: { kind: 'task' },
    status: 'completed',
  })),
  reconcile: vi.fn<RunExecutor['reconcile']>(async () => ({ status: 'not_found' })),
});

let manager: ReturnType<typeof createRunManager> | undefined;
const arrangeManager = (runExecutor = executor()) => {
  dbos.reset();
  manager = createRunManager({ database: { url: 'postgresql://test' }, executor: runExecutor });
  return { manager, runExecutor };
};

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

const status = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  createdAt: 1_000,
  input: [taskExecutionPlan, { request: true }],
  status: 'PENDING',
  workflowID: 'run-id',
  workflowName: 'revo-run.run.v2',
  ...overrides,
});

const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

describe('run manager public behavior', () => {
  it('uses one v2 workflow and returns the caller run ID unchanged after durable start', async () => {
    const arranged = arrangeManager();
    await arranged.manager.start();
    const requestedRunId = 'caller/run id';

    const admitted = await arranged.manager.startRun({
      executionPlan: taskExecutionPlan,
      input: { value: 'input' },
      runId: requestedRunId,
    });

    expect(admitted.runId).toBe(requestedRunId);
    expect(dbos.ids).toEqual([admitted.runId]);
    expect(dbos.registrations).toEqual(['revo-run.run.v2']);
    expect(dbos.arguments[0]).toEqual([taskExecutionPlan, { value: 'input' }]);
    expect(Object.keys(admitted)).toEqual(['runId']);
  });

  it('snapshots the execution plan and input before admission', async () => {
    const arranged = arrangeManager();
    await arranged.manager.start();
    const executionPlan = structuredClone(taskExecutionPlan);
    const input = { nested: { value: 1 } };

    await arranged.manager.startRun({ executionPlan, input, runId: 'mutable-run' });
    input.nested.value = 2;
    Reflect.set(executionPlan.terminalBindings, '0', {
      nodeKey: 'changed',
      outcome: 'changed',
    });

    expect(dbos.arguments[0]).toEqual([taskExecutionPlan, { nested: { value: 1 } }]);
  });

  it.each([
    [
      'cyclic plan',
      () => {
        const plan = structuredClone(taskExecutionPlan) as ExecutionPlan & { cycle?: unknown };
        plan.cycle = plan;
        return { executionPlan: plan, input: null, runId: 'invalid-run' };
      },
    ],
    [
      'non-finite input',
      () => ({ executionPlan: taskExecutionPlan, input: Number.NaN, runId: 'invalid-run' }),
    ],
  ])('rejects %s without creating a DBOS workflow', async (_name, request) => {
    const arranged = arrangeManager();
    await arranged.manager.start();

    await expect(arranged.manager.startRun(request())).rejects.toThrow('JSON-safe');

    expect(dbos.ids).toHaveLength(0);
  });

  it('rejects admission before start and reports durable submission failure', async () => {
    const arranged = arrangeManager();
    await expect(
      arranged.manager.startRun({ executionPlan: taskExecutionPlan, input: null, runId: 'run-id' }),
    ).rejects.toThrow('not started');
    await arranged.manager.start();
    dbos.failNextSubmission();
    await expect(
      arranged.manager.startRun({ executionPlan: taskExecutionPlan, input: null, runId: 'run-id' }),
    ).rejects.toThrow('submission failed');
  });

  it('rejects an empty caller run ID before DBOS admission', async () => {
    const arranged = arrangeManager();
    await arranged.manager.start();

    await expect(
      arranged.manager.startRun({ executionPlan: taskExecutionPlan, input: null, runId: '' }),
    ).rejects.toThrow('non-empty');
    expect(dbos.ids).toHaveLength(0);
  });

  it.each([
    [
      'the same v2 payload',
      status({ input: [taskExecutionPlan, { requested: true }], workflowID: 'duplicate-run' }),
    ],
    [
      'a different v2 payload',
      status({ input: [taskExecutionPlan, { other: true }], workflowID: 'duplicate-run' }),
    ],
    [
      'a foreign workflow',
      status({ workflowID: 'duplicate-run', workflowName: 'foreign.workflow.v1' }),
    ],
  ])('rejects a run ID already used by %s without starting another effect', async (_name, row) => {
    const execute = vi.fn<RunExecutor['execute']>(async () => ({
      completion: { kind: 'task' },
      status: 'completed',
    }));
    const arranged = arrangeManager({ ...executor(), execute });
    dbos.setStatus('duplicate-run', row);
    await arranged.manager.start();

    await expect(
      arranged.manager.startRun({
        executionPlan: taskExecutionPlan,
        input: { requested: true },
        runId: 'duplicate-run',
      }),
    ).rejects.toThrow('already in use');

    expect(dbos.ids).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      'different input',
      status({ input: [taskExecutionPlan, { other: true }], workflowID: 'racing-run' }),
    ],
    [
      'a foreign workflow name',
      status({
        input: [taskExecutionPlan, { requested: true }],
        workflowID: 'racing-run',
        workflowName: 'foreign.workflow.v1',
      }),
    ],
  ])('rejects post-admission adoption of %s without executing it', async (_name, row) => {
    const execute = vi.fn<RunExecutor['execute']>(async () => ({
      completion: { kind: 'task' },
      status: 'completed',
    }));
    const arranged = arrangeManager({ ...executor(), execute });
    dbos.adoptNextSubmission(row);
    await arranged.manager.start();

    await expect(
      arranged.manager.startRun({
        executionPlan: taskExecutionPlan,
        input: { requested: true },
        runId: 'racing-run',
      }),
    ).rejects.toThrow('conflicts with existing workflow data');

    expect(dbos.ids).toEqual(['racing-run']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows identical concurrent v2 submissions to converge after admission', async () => {
    const input = { requested: true };
    const execute = vi.fn<RunExecutor['execute']>(async () => ({
      completion: { kind: 'task' },
      status: 'completed',
    }));
    const arranged = arrangeManager({ ...executor(), execute });
    dbos.adoptNextSubmission(
      status({ input: [taskExecutionPlan, input], workflowID: 'converged-run' }),
    );
    await arranged.manager.start();

    await expect(
      arranged.manager.startRun({
        executionPlan: taskExecutionPlan,
        input,
        runId: 'converged-run',
      }),
    ).resolves.toEqual({ runId: 'converged-run' });

    expect(dbos.ids).toEqual(['converged-run']);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['ENQUEUED', 'pending'],
    ['DELAYED', 'pending'],
    ['PENDING', 'running'],
  ] as const)('maps DBOS %s to public %s', async (dbosStatus, runStatus) => {
    const arranged = arrangeManager();
    dbos.setStatus('run-id', status({ status: dbosStatus }));
    await arranged.manager.start();

    const snapshot = await arranged.manager.getRun('run-id');

    expect(snapshot).toMatchObject({
      createdAt: new Date(1_000),
      executionPlan: taskExecutionPlan,
      id: 'run-id',
      input: { request: true },
      status: runStatus,
      updatedAt: new Date(1_000),
    });
  });

  it('maps a valid terminal envelope and converts both DBOS dates', async () => {
    const arranged = arrangeManager();
    dbos.setStatus(
      'run-id',
      status({
        output: {
          kind: 'revo-run.terminal.v1',
          result: { outcome: 'succeeded' },
          status: 'succeeded',
        },
        status: 'SUCCESS',
        updatedAt: 2_000,
      }),
    );
    await arranged.manager.start();

    await expect(arranged.manager.getRun('run-id')).resolves.toMatchObject({
      createdAt: new Date(1_000),
      result: { outcome: 'succeeded' },
      status: 'succeeded',
      updatedAt: new Date(2_000),
    });
  });

  it('maps ordered task outputs and preserves a non-default successful outcome', async () => {
    const arranged = arrangeManager();
    dbos.setStatus(
      'run-id',
      status({
        input: [sequentialTaskExecutionPlan, { request: true }],
        output: {
          kind: 'revo-run.terminal.v1',
          result: {
            outcome: 'published',
            outputs: [
              { nodeKey: 'first', value: { nested: [1, true, null] } },
              { nodeKey: 'second', value: 'complete' },
            ],
          },
          status: 'succeeded',
        },
        status: 'SUCCESS',
        updatedAt: 2_000,
      }),
    );
    await arranged.manager.start();

    await expect(arranged.manager.getRun('run-id')).resolves.toMatchObject({
      createdAt: new Date(1_000),
      executionPlan: sequentialTaskExecutionPlan,
      result: {
        outcome: 'published',
        outputs: [
          { nodeKey: 'first', value: { nested: [1, true, null] } },
          { nodeKey: 'second', value: 'complete' },
        ],
      },
      status: 'succeeded',
      updatedAt: new Date(2_000),
    });
  });

  it('preserves special own string keys in a parsed task output', async () => {
    const output: Record<string, unknown> = {};
    Object.defineProperty(output, '__proto__', {
      enumerable: true,
      value: { safe: true },
    });
    const arranged = arrangeManager();
    dbos.setStatus(
      'run-id',
      status({
        output: {
          kind: 'revo-run.terminal.v1',
          result: { outcome: 'succeeded', outputs: [{ nodeKey: 'task', value: output }] },
          status: 'succeeded',
        },
        status: 'SUCCESS',
      }),
    );
    await arranged.manager.start();

    const snapshot = await arranged.manager.getRun('run-id');
    const result = snapshot?.result;
    if (!isUnknownRecord(result) || !Array.isArray(result['outputs'])) {
      throw new Error('Snapshot result has no task outputs.');
    }
    const outputs: readonly unknown[] = result['outputs'];
    const first = outputs[0];
    if (!isUnknownRecord(first)) {
      throw new Error('Snapshot task output entry is invalid.');
    }
    const parsed = first['value'];

    expect(parsed).toEqual({ ['__proto__']: { safe: true } });
    if (!isUnknownRecord(parsed)) {
      throw new Error('Snapshot task output value is invalid.');
    }
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(({} as { safe?: boolean }).safe).toBeUndefined();
  });

  it.each([
    ['ERROR', 'workflow_failed'],
    ['MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'recovery_exhausted'],
    ['UNKNOWN', 'invalid_workflow_state'],
  ] as const)('maps DBOS %s to sanitized %s', async (dbosStatus, code) => {
    const arranged = arrangeManager();
    dbos.setStatus(
      'run-id',
      status({ error: new Error('secret stack and provider details'), status: dbosStatus }),
    );
    await arranged.manager.start();

    const snapshot = await arranged.manager.getRun('run-id');

    expect(snapshot).toMatchObject({ error: { code }, status: 'failed' });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('maps DBOS cancellation without an error field', async () => {
    const arranged = arrangeManager();
    dbos.setStatus('run-id', status({ error: new Error('private'), status: 'CANCELLED' }));
    await arranged.manager.start();

    const snapshot = await arranged.manager.getRun('run-id');

    expect(snapshot).toMatchObject({ status: 'cancelled' });
    expect(snapshot).not.toHaveProperty('error');
  });

  it.each([
    { kind: 'wrong', result: null, status: 'succeeded' },
    { kind: 'revo-run.terminal.v1', status: 'succeeded' },
    { error: { code: 'provider_secret' }, kind: 'revo-run.terminal.v1', status: 'failed' },
    { error: { code: 'execution_failed' }, kind: 'revo-run.terminal.v1', status: 'failed' },
    { kind: 'revo-run.terminal.v1', result: undefined, status: 'succeeded' },
  ])('maps malformed SUCCESS output to invalid_workflow_state', async (output) => {
    const arranged = arrangeManager();
    dbos.setStatus('run-id', status({ output, status: 'SUCCESS' }));
    await arranged.manager.start();

    await expect(arranged.manager.getRun('run-id')).resolves.toMatchObject({
      error: { code: 'invalid_workflow_state' },
      status: 'failed',
    });
  });

  it.each([
    ['empty outputs', taskExecutionPlan, { outcome: 'succeeded', outputs: [] }],
    [
      'duplicate node keys',
      taskExecutionPlan,
      {
        outcome: 'succeeded',
        outputs: [
          { nodeKey: 'task', value: 1 },
          { nodeKey: 'task', value: 2 },
        ],
      },
    ],
    [
      'foreign node key',
      taskExecutionPlan,
      { outcome: 'succeeded', outputs: [{ nodeKey: 'foreign', value: null }] },
    ],
    [
      'candidate key',
      candidateExecutionPlan,
      { outcome: 'succeeded', outputs: [{ nodeKey: 'a', value: null }] },
    ],
    [
      'consensus node key',
      candidateExecutionPlan,
      { outcome: 'succeeded', outputs: [{ nodeKey: 'review', value: null }] },
    ],
    [
      'terminal node key',
      taskExecutionPlan,
      { outcome: 'succeeded', outputs: [{ nodeKey: 'done', value: null }] },
    ],
    ['extra result property', taskExecutionPlan, { extra: true, outcome: 'succeeded' }],
    [
      'extra output property',
      taskExecutionPlan,
      { outcome: 'succeeded', outputs: [{ extra: true, nodeKey: 'task', value: null }] },
    ],
    [
      'missing output value',
      taskExecutionPlan,
      { outcome: 'succeeded', outputs: [{ nodeKey: 'task' }] },
    ],
  ])('rejects a successful result with %s', async (_name, plan, result) => {
    const arranged = arrangeManager();
    dbos.setStatus(
      'run-id',
      status({
        input: [plan, { request: true }],
        output: { kind: 'revo-run.terminal.v1', result, status: 'succeeded' },
        status: 'SUCCESS',
      }),
    );
    await arranged.manager.start();

    await expect(arranged.manager.getRun('run-id')).resolves.toMatchObject({
      error: { code: 'invalid_workflow_state' },
      status: 'failed',
    });
  });

  it('rejects adversarial output descriptors without invoking getters', async () => {
    let getterCalls = 0;
    const value = {};
    Object.defineProperty(value, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'private';
      },
    });
    const arranged = arrangeManager();
    dbos.setStatus(
      'run-id',
      status({
        output: {
          kind: 'revo-run.terminal.v1',
          result: { outcome: 'succeeded', outputs: [{ nodeKey: 'task', value }] },
          status: 'succeeded',
        },
        status: 'SUCCESS',
      }),
    );
    await arranged.manager.start();

    await expect(arranged.manager.getRun('run-id')).resolves.toMatchObject({
      error: { code: 'invalid_workflow_state' },
      status: 'failed',
    });
    expect(getterCalls).toBe(0);
  });

  it.each([
    [{ kind: 'revo-run.terminal.v1', status: 'cancelled' }, 'cancelled', undefined],
    [
      {
        error: { code: 'execution_failed', message: 'Bounded execution failure.' },
        kind: 'revo-run.terminal.v1',
        status: 'failed',
      },
      'failed',
      'execution_failed',
    ],
    [
      {
        error: { code: 'invalid_workflow_state' },
        kind: 'revo-run.terminal.v1',
        status: 'failed',
      },
      'failed',
      'invalid_workflow_state',
    ],
  ] as const)('maps each valid private terminal envelope', async (output, runStatus, code) => {
    const arranged = arrangeManager();
    dbos.setStatus('run-id', status({ output, status: 'SUCCESS' }));
    await arranged.manager.start();

    const snapshot = await arranged.manager.getRun('run-id');

    expect(snapshot?.status).toBe(runStatus);
    expect(snapshot?.error?.code).toBe(code);
  });

  it('retains a bounded executor failure message in the public snapshot', async () => {
    const arranged = arrangeManager();
    dbos.setStatus(
      'run-id',
      status({
        output: {
          error: { code: 'execution_failed', message: 'External execution was rejected.' },
          kind: 'revo-run.terminal.v1',
          status: 'failed',
        },
        status: 'SUCCESS',
      }),
    );
    await arranged.manager.start();

    await expect(arranged.manager.getRun('run-id')).resolves.toMatchObject({
      error: { code: 'execution_failed', message: 'External execution was rejected.' },
      status: 'failed',
    });
  });

  it('guards workflow names and returns undefined for an absent run', async () => {
    const arranged = arrangeManager();
    dbos.setStatus('foreign', status({ workflowID: 'foreign', workflowName: 'foreign.v1' }));
    await arranged.manager.start();

    await expect(arranged.manager.getRun('foreign')).resolves.toBeUndefined();
    await expect(arranged.manager.getRun('absent')).resolves.toBeUndefined();
  });

  it('accepts any non-empty run ID without format assumptions', async () => {
    const arranged = arrangeManager();
    const runId = 'external/string with spaces';
    dbos.setStatus(runId, status({ workflowID: runId }));
    await arranged.manager.start();

    await expect(arranged.manager.getRun(runId)).resolves.toMatchObject({ id: runId });
  });
});
