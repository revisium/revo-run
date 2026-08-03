import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';
import { describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => {
  const events = new Map<string, unknown>();
  const workflowIds: string[] = [];
  const workflowResults: Promise<unknown>[] = [];
  return {
    ackBarrier: null as Promise<void> | null,
    events,
    failRegistration: true,
    failSubmission: false,
    getEvent: vi.fn<(workflowId: string, key: string) => Promise<unknown>>(
      async (workflowId, key) => {
        if (dbos.ackBarrier) await dbos.ackBarrier;
        return events.get(`${workflowId}:${key}`) ?? null;
      },
    ),
    launch: vi.fn<() => Promise<void>>(),
    setConfig: vi.fn<(configuration: unknown) => void>(),
    setEvent: vi.fn<(key: string, value: unknown) => Promise<void>>(async (key, value) => {
      const workflowId = workflowIds.at(-1);
      if (workflowId) events.set(`${workflowId}:${key}`, value);
    }),
    shutdown: vi.fn<() => Promise<void>>(),
    workflowIds,
    workflowResults,
  };
});

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    getEvent: dbos.getEvent,
    launch: dbos.launch,
    registerWorkflow: <Arguments extends unknown[], Result>(
      workflow: (...arguments_: Arguments) => Promise<Result>,
    ) => {
      if (dbos.failRegistration) {
        dbos.failRegistration = false;
        throw new Error('registration failed');
      }
      return workflow;
    },
    runStep: <Result>(operation: () => Promise<Result>) => operation(),
    setConfig: dbos.setConfig,
    setEvent: dbos.setEvent,
    shutdown: dbos.shutdown,
    startWorkflow:
      <Arguments extends unknown[], Result>(
        workflow: (...arguments_: Arguments) => Promise<Result>,
        parameters: { readonly workflowID?: string },
      ) =>
      async (...arguments_: Arguments) => {
        if (dbos.failSubmission) {
          dbos.failSubmission = false;
          throw new Error('submission failed');
        }
        if (parameters.workflowID) dbos.workflowIds.push(parameters.workflowID);
        const result = workflow(...arguments_);
        dbos.workflowResults.push(result);
        void result.catch(() => undefined);
        return { getResult: () => result };
      },
  },
}));

import {
  createRunManager,
  type CreateRunManagerOptions,
  type RunManagerSnapshot,
} from '../../src/index.js';
import { deriveChildWorkflowId } from '../../src/lifecycle/pipeline-construction.js';

const compilation = compilePipeline(
  definePipeline({
    schemaVersion: 1,
    entry: 'task',
    facts: [],
    nodes: [
      {
        kind: 'task',
        key: 'task',
        outcomes: {
          completed: 'fork',
          failed: 'failed',
          cancelled: 'failed',
          skipped: 'failed',
        },
      },
      {
        kind: 'fork',
        key: 'fork',
        join: 'join',
        branches: [
          { name: 'one', entry: 'one', exit: 'one' },
          { name: 'two', entry: 'two', exit: 'two' },
        ],
      },
      {
        kind: 'task',
        key: 'one',
        outcomes: { completed: 'join', failed: 'join', cancelled: 'join', skipped: 'join' },
      },
      {
        kind: 'task',
        key: 'two',
        outcomes: { completed: 'join', failed: 'join', cancelled: 'join', skipped: 'join' },
      },
      {
        kind: 'join',
        key: 'join',
        fork: 'fork',
        policy: { kind: 'all' },
        outcomes: { completed: 'review', rejected: 'failed', insufficient: 'failed' },
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

if (!compilation.ok) throw new Error('Test pipeline must compile.');
const compiledPipeline = compilation.pipeline;

const pin = { digest: 'sha256:plan', id: 'plan-1', revision: 'revision-1' };

describe('DBOS run manager MVP', () => {
  it('serializes global lifecycle, submits durably, and preserves exact plan authority', async () => {
    const snapshots = new Map<string, RunManagerSnapshot>();
    const updateAttempts: RunManagerSnapshot[] = [];
    let executorOutcome: 'completed' | 'failed' = 'completed';
    let failTerminalProjection = false;
    let runSequence = 0;
    const loadExact = vi.fn<() => Promise<{ compiledPipeline: typeof compiledPipeline }>>(
      async () => ({ compiledPipeline }),
    );
    const options: CreateRunManagerOptions = {
      applicationName: 'test-manager',
      systemDatabaseUrl: 'postgresql://test',
      executor: { execute: async () => ({ outcome: executorOutcome }) },
      ids: {
        nextRunId: () => {
          runSequence += 1;
          return `run-${runSequence}`;
        },
      },
      plans: { loadExact },
      snapshots: {
        create: async (snapshot) => void snapshots.set(snapshot.id, snapshot),
        get: async (runId) => snapshots.get(runId),
        update: async (snapshot) => {
          updateAttempts.push(snapshot);
          if (failTerminalProjection && snapshot.status === 'succeeded') {
            throw new Error('snapshot store unavailable');
          }
          snapshots.set(snapshot.id, snapshot);
        },
      },
    };
    expect(() => createRunManager(options)).toThrow('registration failed');
    const manager = createRunManager(options);

    expect(() => createRunManager(options)).toThrow(
      'Only one run manager may be created per process.',
    );
    await expect(manager.startRun({ input: {}, planPin: pin })).rejects.toThrow(
      'Run manager is not started.',
    );

    dbos.launch.mockRejectedValueOnce(new Error('launch failed'));
    await expect(manager.start()).rejects.toThrow('launch failed');
    await Promise.all([manager.start(), manager.start()]);
    expect(dbos.launch).toHaveBeenCalledTimes(2);

    dbos.failSubmission = true;
    await expect(manager.startRun({ input: null, planPin: pin })).rejects.toThrow(
      'submission failed',
    );
    expect(snapshots.size).toBe(0);
    runSequence = 0;

    let releaseAcknowledgement = (): void => undefined;
    dbos.ackBarrier = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    const mutablePin = { ...pin };
    const admitted = manager.startRun({ input: { value: 1 }, planPin: mutablePin });
    mutablePin.id = 'mutated-plan';
    const stopping = manager.stop();
    await Promise.resolve();
    expect(dbos.shutdown).not.toHaveBeenCalled();
    releaseAcknowledgement();
    const created = await admitted;
    await stopping;
    dbos.ackBarrier = null;
    expect(created).toMatchObject({ planPin: pin, status: 'pending' });
    expect(Object.isFrozen(created.planPin)).toBe(true);
    expect(loadExact).toHaveBeenCalledWith(pin);
    await vi.waitFor(() => expect(snapshots.get('run-1')?.status).toBe('succeeded'));
    expect(dbos.workflowIds).toContain('run-1');
    expect(dbos.workflowIds).toContain(deriveChildWorkflowId('run-1', 'task', 'task'));
    expect(dbos.workflowIds).toContain(deriveChildWorkflowId('run-1', 'task', 'one'));
    expect(dbos.workflowIds).toContain(deriveChildWorkflowId('run-1', 'task', 'two'));
    expect(dbos.workflowIds).toContain(deriveChildWorkflowId('run-1', 'candidate', 'review', 'a'));
    expect(dbos.workflowIds).toContain(deriveChildWorkflowId('run-1', 'candidate', 'review', 'b'));

    failTerminalProjection = true;
    await manager.start();
    const parentResultIndex = dbos.workflowResults.length;
    await manager.startRun({ input: null, planPin: pin });
    await expect(dbos.workflowResults[parentResultIndex]).rejects.toThrow(
      'snapshot store unavailable',
    );
    expect(updateAttempts.filter(({ id }) => id === 'run-2').map(({ status }) => status)).toEqual([
      'running',
      'succeeded',
    ]);
    expect(snapshots.get('run-2')?.status).toBe('running');

    dbos.shutdown.mockRejectedValueOnce(new Error('shutdown failed'));
    await expect(Promise.all([manager.stop(), manager.stop()])).rejects.toThrow('shutdown failed');
    await manager.stop();
    await manager.start();
    await manager.stop();
    expect(dbos.shutdown).toHaveBeenCalledTimes(4);

    executorOutcome = 'failed';
  });

  it('derives bounded collision-free child IDs from adversarial tuples', () => {
    const ids = [
      deriveChildWorkflowId('run.a', 'task', 'b'),
      deriveChildWorkflowId('run', 'task', 'a.b'),
      deriveChildWorkflowId('run', 'candidate', 'a', 'b.c'),
      deriveChildWorkflowId('run', 'candidate', 'a.b', 'c'),
      deriveChildWorkflowId('x'.repeat(100_000), 'task', 'y'.repeat(100_000)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length <= 80)).toBe(true);
    expect(deriveChildWorkflowId('run', 'task', 'node')).toBe(
      deriveChildWorkflowId('run', 'task', 'node'),
    );
  });
});
