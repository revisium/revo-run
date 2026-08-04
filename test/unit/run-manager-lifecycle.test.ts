import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  launch: vi.fn<() => Promise<void>>(),
  registrations: [] as string[],
  shutdown: vi.fn<() => Promise<void>>(),
  workflows: new Map<string, unknown>(),
}));

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    launch: dbos.launch,
    registerWorkflow: <Arguments extends unknown[], Result>(
      workflow: (...arguments_: Arguments) => Promise<Result>,
      options: { name: string },
    ) => {
      dbos.registrations.push(options.name);
      dbos.workflows.set(options.name, workflow);
      return workflow;
    },
    runStep: <Result>(operation: () => Promise<Result>) => operation(),
    setConfig: vi.fn<(configuration: unknown) => void>(),
    shutdown: dbos.shutdown,
  },
}));

import { createRunManager } from '../../src/index.js';

const options = () => ({
  database: { url: 'postgresql://test' },
  plans: {
    loadExact: vi.fn<() => Promise<{ compiledPipeline: null }>>(async () => ({
      compiledPipeline: null,
    })),
  },
  executor: {
    execute: vi.fn<() => Promise<{ outcome: 'completed' }>>(async () => ({
      outcome: 'completed',
    })),
  },
  snapshots: {
    create: vi.fn<() => Promise<void>>(async () => undefined),
    update: vi.fn<() => Promise<void>>(async () => undefined),
    get: vi.fn<() => Promise<undefined>>(async () => undefined),
  },
});

const deferred = (): {
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
} => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

type TaskWorkflow = (runId: string, nodeKey: string, input: null) => Promise<unknown>;

const isTaskWorkflow = (value: unknown): value is TaskWorkflow => typeof value === 'function';

describe('run manager process ownership', () => {
  beforeEach(() => {
    dbos.launch.mockReset();
    dbos.shutdown.mockReset();
  });

  it('rejects a second manager while the first is active', async () => {
    const manager = createRunManager(options());
    await manager.start();

    expect(() => createRunManager(options())).toThrow(
      'Only one run manager may be created per process.',
    );

    await Promise.all([manager.stop(), manager.stop()]);
    expect(dbos.shutdown).toHaveBeenCalledOnce();
  });

  it('retains ownership until shutdown completes and permanently stops the old manager', async () => {
    const shutdown = deferred();
    dbos.shutdown.mockReturnValueOnce(shutdown.promise);
    const manager = createRunManager(options());
    await manager.start();

    const stopping = manager.stop();
    await vi.waitFor(() => expect(dbos.shutdown).toHaveBeenCalledOnce());
    expect(() => createRunManager(options())).toThrow(
      'Only one run manager may be created per process.',
    );

    shutdown.resolve();
    await stopping;
    const replacement = createRunManager(options());
    await expect(manager.start()).rejects.toThrow('Run manager has been stopped.');
    await expect(
      manager.startRun({ planPin: { id: 'p', revision: '1', digest: 'd' }, input: null }),
    ).rejects.toThrow('Run manager is not started.');
    await replacement.stop();
  });

  it('registers workflows once and dispatches them through only the current manager', async () => {
    const firstOptions = options();
    const first = createRunManager(firstOptions);
    const task = dbos.workflows.get('revo-run.task.v1');
    if (!isTaskWorkflow(task)) throw new Error('task workflow was not registered');

    await first.stop();
    await expect(task('run-1', 'task', null)).rejects.toThrow(
      'Run manager workflow context is not active.',
    );

    const secondOptions = options();
    const second = createRunManager(secondOptions);
    await expect(task('run-2', 'task', null)).resolves.toBe('completed');
    expect(firstOptions.executor.execute).not.toHaveBeenCalled();
    expect(secondOptions.executor.execute).toHaveBeenCalledWith({
      runId: 'run-2',
      nodeKey: 'task',
      input: null,
    });
    expect(dbos.registrations).toEqual([
      'revo-run.task.v1',
      'revo-run.candidate.v1',
      'revo-run.run.v1',
    ]);

    await second.stop();
  });

  it('retains ownership after start failure until stop completes', async () => {
    dbos.launch.mockRejectedValueOnce(new Error('launch failed'));
    const manager = createRunManager(options());

    await expect(manager.start()).rejects.toThrow('launch failed');
    expect(() => createRunManager(options())).toThrow(
      'Only one run manager may be created per process.',
    );

    await manager.stop();
    const replacement = createRunManager(options());
    await replacement.stop();
  });

  it('retains ownership after stop failure and releases it after a successful retry', async () => {
    dbos.shutdown.mockRejectedValueOnce(new Error('shutdown failed'));
    const manager = createRunManager(options());
    await manager.start();

    await expect(manager.stop()).rejects.toThrow('shutdown failed');
    expect(() => createRunManager(options())).toThrow(
      'Only one run manager may be created per process.',
    );

    await Promise.all([manager.stop(), manager.stop()]);
    expect(dbos.shutdown).toHaveBeenCalledTimes(2);
    const replacement = createRunManager(options());
    await replacement.stop();
  });
});
