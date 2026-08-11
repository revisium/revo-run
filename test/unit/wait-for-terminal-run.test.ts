import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForTerminalRun } from '../../src/dbos/read-model/wait-for-terminal-run.js';
import { RunManagerError } from '../../src/index.js';
import { RunManager } from '../../src/manager/run-manager.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const running = {
  id: 'Run_1',
  status: 'running',
  executionPlan: terminalExecutionPlan(),
  input: null,
  createdAt: new Date(1),
  updatedAt: new Date(2),
} as const;

const succeeded = {
  ...running,
  status: 'succeeded',
  result: { outcome: 'completed' },
} as const;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
};

afterEach(() => vi.useRealTimers());

describe('authoritative terminal waiting', () => {
  it('returns an initially terminal snapshot without polling', async () => {
    const read = vi.fn<() => Promise<typeof succeeded>>(async () => succeeded);

    await expect(waitForTerminalRun(read, {}, new AbortController().signal)).resolves.toBe(
      succeeded,
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('preserves a synchronous authoritative read failure', async () => {
    const failure = new Error('synchronous read failed');
    const read = vi.fn<() => Promise<typeof running>>(() => {
      throw failure;
    });

    await expect(waitForTerminalRun(read, {}, new AbortController().signal)).rejects.toBe(failure);
  });

  it('preserves an asynchronous authoritative read failure', async () => {
    const failure = new Error('asynchronous read failed');
    const read = vi.fn<() => Promise<typeof running>>(() => Promise.reject(failure));

    await expect(waitForTerminalRun(read, {}, new AbortController().signal)).rejects.toBe(failure);
  });

  it('performs the deadline read before reporting a timeout', async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<() => Promise<typeof running | typeof succeeded>>()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(succeeded);
    const waiting = waitForTerminalRun(read, { timeoutMs: 1 }, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(1);

    await expect(waiting).resolves.toBe(succeeded);
  });

  it('reports a typed timeout only after the final authoritative read', async () => {
    vi.useFakeTimers();
    const read = vi.fn<() => Promise<typeof running>>(async () => running);
    const waiting = waitForTerminalRun(read, { timeoutMs: 1 }, new AbortController().signal);
    const rejection = waiting.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1);

    await expect(rejection).resolves.toMatchObject({ code: 'run_wait_timed_out' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('lets manager stop outrank a terminal value from an in-flight read', async () => {
    const read = deferred<typeof succeeded>();
    const manager = new AbortController();
    const waiting = waitForTerminalRun(() => read.promise, {}, manager.signal);

    manager.abort();
    read.resolve(succeeded);

    await expect(waiting).rejects.toMatchObject({ code: 'manager_not_started' });
  });

  it('lets user abort outrank a terminal value from an in-flight read', async () => {
    const read = deferred<typeof succeeded>();
    const user = new AbortController();
    const waiting = waitForTerminalRun(
      () => read.promise,
      { signal: user.signal },
      new AbortController().signal,
    );

    user.abort();
    read.resolve(succeeded);

    await expect(waiting).rejects.toMatchObject({ code: 'run_wait_aborted' });
  });

  it('promptly observes manager stop while the authoritative read never settles', async () => {
    const manager = new AbortController();
    const waiting = waitForTerminalRun(
      () => new Promise<never>(() => undefined),
      {},
      manager.signal,
    );

    manager.abort();

    await expect(waiting).rejects.toMatchObject({ code: 'manager_not_started' });
  });

  it('promptly observes user abort while the authoritative read never settles', async () => {
    const user = new AbortController();
    const waiting = waitForTerminalRun(
      () => new Promise<never>(() => undefined),
      { signal: user.signal },
      new AbortController().signal,
    );

    user.abort();

    await expect(waiting).rejects.toMatchObject({ code: 'run_wait_aborted' });
  });

  it('lets a terminal deadline read outrank timeout', async () => {
    vi.useFakeTimers();
    const deadlineRead = deferred<typeof succeeded>();
    const read = vi
      .fn<() => Promise<typeof running | typeof succeeded>>()
      .mockResolvedValueOnce(running)
      .mockImplementationOnce(() => deadlineRead.promise);
    const waiting = waitForTerminalRun(read, { timeoutMs: 1 }, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(1);
    deadlineRead.resolve(succeeded);

    await expect(waiting).resolves.toBe(succeeded);
  });

  it('preserves a deadline read failure instead of replacing it with timeout', async () => {
    vi.useFakeTimers();
    const deadlineRead = deferred<typeof running>();
    const failure = new Error('authoritative read failed');
    const read = vi
      .fn<() => Promise<typeof running>>()
      .mockResolvedValueOnce(running)
      .mockImplementationOnce(() => deadlineRead.promise);
    const waiting = waitForTerminalRun(read, { timeoutMs: 1 }, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(1);
    deadlineRead.reject(failure);

    await expect(waiting).rejects.toBe(failure);
  });

  it('lets manager stop outrank an in-flight read failure', async () => {
    const read = deferred<typeof running>();
    const manager = new AbortController();
    const failure = new Error('read failed after stop');
    const waiting = waitForTerminalRun(() => read.promise, {}, manager.signal);

    manager.abort();
    read.reject(failure);

    await expect(waiting).rejects.toMatchObject({ code: 'manager_not_started' });
  });

  it('turns a manager stop during a wait into manager_not_started', async () => {
    const adapter = {
      start: async () => undefined,
      stop: async () => undefined,
      startRun: async () => undefined,
      getRun: async () => undefined,
      listRuns: async () => ({ items: [] }),
      getRunDetails: async () => undefined,
      getRunEvents: async () => ({ items: [], hasMore: false }),
      subscribeRunEvents: async function* () {},
      waitForTerminal: async (_runId: string, _input: unknown, managerSignal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          managerSignal.addEventListener('abort', () => {
            reject(new RunManagerError('manager_not_started'));
          });
        }),
    };
    const manager = new RunManager(adapter);
    await manager.start();
    const waiting = manager.waitForTerminal('Run_1');

    await manager.stop();

    await expect(waiting).rejects.toMatchObject({ code: 'manager_not_started' });
  });

  it('lets a stop-in-progress lifecycle outrank an already-aborted user signal', async () => {
    const stopping = deferred<void>();
    const adapter = {
      start: async () => undefined,
      stop: () => stopping.promise,
      startRun: async () => undefined,
      getRun: async () => undefined,
      listRuns: async () => ({ items: [] }),
      getRunDetails: async () => undefined,
      getRunEvents: async () => ({ items: [], hasMore: false }),
      subscribeRunEvents: async function* () {},
      waitForTerminal: vi.fn<() => Promise<typeof succeeded>>(async () => succeeded),
    };
    const manager = new RunManager(adapter);
    await manager.start();
    const stop = manager.stop();
    const user = new AbortController();
    user.abort();

    await expect(manager.waitForTerminal('Run_1', { signal: user.signal })).rejects.toMatchObject({
      code: 'manager_not_started',
    });
    stopping.resolve();
    await expect(stop).resolves.toBeUndefined();
    expect(adapter.waitForTerminal).not.toHaveBeenCalled();
  });
});
