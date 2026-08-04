import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';
import { describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => {
  const events = new Map<string, unknown>();
  const ids: string[] = [];
  const results: Promise<unknown>[] = [];
  return {
    events,
    ids,
    results,
    failSubmission: false,
    missNextEvent: false,
    getEvent: vi.fn<(id: string, key: string) => Promise<unknown>>(async (id, key) => {
      if (dbos.missNextEvent) {
        dbos.missNextEvent = false;
        return null;
      }
      return events.get(`${id}:${key}`) ?? null;
    }),
    launch: vi.fn<() => Promise<void>>(),
    setConfig: vi.fn<(configuration: unknown) => void>(),
    sleepms: vi.fn<(duration: number) => Promise<void>>(),
    shutdown: vi.fn<() => Promise<void>>(),
  };
});

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    getEvent: dbos.getEvent,
    launch: dbos.launch,
    registerWorkflow: <Arguments extends unknown[], Result>(
      workflow: (...arguments_: Arguments) => Promise<Result>,
    ) => workflow,
    runStep: <Result>(operation: () => Promise<Result>) => operation(),
    setConfig: dbos.setConfig,
    setEvent: async (key: string, value: unknown) => {
      const id = dbos.ids.at(-1);
      if (id) dbos.events.set(`${id}:${key}`, value);
    },
    sleepms: dbos.sleepms,
    shutdown: dbos.shutdown,
    startWorkflow:
      <Arguments extends unknown[], Result>(
        workflow: (...arguments_: Arguments) => Promise<Result>,
        options: { workflowID?: string },
      ) =>
      async (...arguments_: Arguments) => {
        if (dbos.failSubmission) {
          dbos.failSubmission = false;
          throw new Error('submission failed');
        }
        if (options.workflowID) dbos.ids.push(options.workflowID);
        const result = workflow(...arguments_);
        dbos.results.push(result);
        void result.catch(() => undefined);
        return { getResult: () => result };
      },
  },
}));

import { createRunManager, type JsonValue, type RunSnapshot } from '../../src/index.js';

const compiled = compilePipeline(
  definePipeline({
    schemaVersion: 1,
    entry: 'task',
    facts: [],
    nodes: [
      {
        kind: 'task',
        key: 'task',
        outcomes: { completed: 'review', failed: 'failed', cancelled: 'failed', skipped: 'failed' },
      },
      {
        kind: 'consensus',
        key: 'review',
        candidates: ['a', 'b'],
        policy: { kind: 'quorum', quorum: 2 },
        outcomes: { approved: 'done', rejected: 'failed', insufficient: 'failed', tied: 'failed' },
      },
      { kind: 'terminal', key: 'done', outcome: 'succeeded' },
      { kind: 'terminal', key: 'failed', outcome: 'failed' },
    ],
  }),
);
if (!compiled.ok) throw new Error('fixture compilation failed');
const compiledPipeline = compiled.pipeline;

describe('run manager', () => {
  it('owns IDs, lifecycle, immutable admission, submission, execution, and projection', async () => {
    const snapshots = new Map<string, RunSnapshot>();
    let executorOutcome: 'completed' | 'failed' = 'completed';
    let planSource: JsonValue = compiledPipeline;
    const projectionFailures = new Map<RunSnapshot['status'], number>();
    let changeOutcomeOnTerminalFailure = false;
    const project = async (snapshot: RunSnapshot): Promise<void> => {
      const remaining = projectionFailures.get(snapshot.status) ?? 0;
      if (remaining > 0) {
        projectionFailures.set(snapshot.status, remaining - 1);
        if (snapshot.status === 'succeeded' && changeOutcomeOnTerminalFailure)
          executorOutcome = 'failed';
        throw new Error('projection unavailable');
      }
      snapshots.set(snapshot.id, snapshot);
    };
    const execute = vi.fn<() => Promise<{ outcome: 'completed' | 'failed' }>>(async () => ({
      outcome: executorOutcome,
    }));
    const manager = createRunManager({
      database: { url: 'postgresql://test' },
      plans: {
        loadExact: vi.fn<() => Promise<{ compiledPipeline: JsonValue }>>(async () => ({
          compiledPipeline: planSource,
          taskInputs: { task: ['exact'] },
        })),
      },
      executor: { execute },
      snapshots: {
        create: project,
        update: project,
        get: async (id) => snapshots.get(id),
      },
    });
    await expect(
      manager.startRun({ planPin: { id: 'p', revision: '1', digest: 'd' }, input: null }),
    ).rejects.toThrow('not started');
    dbos.launch.mockRejectedValueOnce(new Error('launch failed'));
    await expect(manager.start()).rejects.toThrow('launch failed');
    await Promise.all([manager.start(), manager.start()]);
    expect(dbos.setConfig).toHaveBeenCalledWith({
      name: 'revo-run',
      systemDatabaseUrl: 'postgresql://test',
    });
    const input = { nested: { value: 1 } };
    const planPin = { id: 'p', revision: '1', digest: 'd' };
    const admitted = await manager.startRun({ planPin, input });
    input.nested.value = 2;
    planPin.id = 'changed';
    expect(admitted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(admitted).toMatchObject({ input: { nested: { value: 1 } }, planPin: { id: 'p' } });
    expect(Object.isFrozen(admitted.input)).toBe(true);
    await vi.waitFor(() => expect(snapshots.get(admitted.id)?.status).toBe('succeeded'));
    dbos.missNextEvent = true;
    const acknowledgedAfterPollTimeout = await manager.startRun({ planPin, input: null });
    expect(dbos.ids.filter((id) => id === acknowledgedAfterPollTimeout.id)).toHaveLength(1);
    const verifyProjectionFailure = async (status: RunSnapshot['status']): Promise<void> => {
      projectionFailures.clear();
      projectionFailures.set(status, 2);
      const resultIndex = dbos.results.length;
      const accepted = await manager.startRun({ planPin, input: null });
      expect(accepted.status).toBe('pending');
      await expect(Promise.all(dbos.results.slice(resultIndex))).resolves.toContainEqual(
        expect.objectContaining({ status: 'succeeded' }),
      );
      await vi.waitFor(() => expect(snapshots.get(accepted.id)?.status).toBe('succeeded'));
    };
    await verifyProjectionFailure('pending');
    await verifyProjectionFailure('running');
    const callsBeforeTerminalRetry = execute.mock.calls.length;
    changeOutcomeOnTerminalFailure = true;
    await verifyProjectionFailure('succeeded');
    expect([...snapshots.values()].at(-1)).toMatchObject({ status: 'succeeded' });
    expect(execute.mock.calls.length - callsBeforeTerminalRetry).toBe(3);
    expect(dbos.sleepms.mock.calls.map(([duration]) => duration)).toEqual([
      100, 200, 100, 200, 100, 200,
    ]);
    changeOutcomeOnTerminalFailure = false;
    executorOutcome = 'completed';
    projectionFailures.clear();
    dbos.failSubmission = true;
    await expect(manager.startRun({ planPin, input: null })).rejects.toThrow('submission failed');
    executorOutcome = 'failed';
    const failed = await manager.startRun({ planPin, input: null });
    await vi.waitFor(() => expect(snapshots.get(failed.id)?.status).toBe('failed'));
    planSource = null;
    const invalid = await manager.startRun({ planPin, input: null });
    await vi.waitFor(() => expect(snapshots.get(invalid.id)?.error).toContain('invalid compiled'));
    dbos.shutdown.mockRejectedValueOnce(new Error('shutdown failed'));
    await expect(manager.stop()).rejects.toThrow('shutdown failed');
    await expect(manager.start()).rejects.toThrow('shutdown state is uncertain');
    await expect(manager.startRun({ planPin, input: null })).rejects.toThrow('not started');
    await Promise.all([manager.stop(), manager.stop()]);
  });
});
