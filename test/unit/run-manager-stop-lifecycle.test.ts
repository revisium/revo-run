import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunManagerError } from '../../src/index.js';
import {
  managerShutdownResponseMs,
  managerStopGraceMs,
  RunManagerLifecycle,
} from '../../src/manager/run-manager-lifecycle.js';

const deferred = <Value = void>() => {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<Value>((fulfilled, failed) => {
    resolve = fulfilled;
    reject = failed;
  });
  return { promise, reject, resolve };
};

describe('run manager bounded stop lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('closes admission synchronously and drains entered finite work before shutdown', async () => {
    const active = deferred();
    const shutdown = deferred();
    const runtime = {
      start: vi.fn<() => Promise<void>>(async () => undefined),
      stop: vi.fn<() => Promise<void>>(() => shutdown.promise),
    };
    const lifecycle = new RunManagerLifecycle(runtime);
    await lifecycle.start();
    const operation = lifecycle.track(() => active.promise);

    const stopping = lifecycle.stop();
    expect(() => lifecycle.assertRunning()).toThrowError(
      expect.objectContaining<Partial<RunManagerError>>({ code: 'manager_not_started' }),
    );
    expect(lifecycle.signal.aborted).toBe(true);
    expect(runtime.stop).not.toHaveBeenCalled();

    active.resolve();
    await operation;
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.stop).toHaveBeenCalledOnce();
    shutdown.resolve();
    await expect(stopping).resolves.toBeUndefined();
  });

  it('bounds signal-ignoring lifecycle work by the grace deadline before shutdown', async () => {
    const active = deferred();
    const runtime = {
      start: vi.fn<() => Promise<void>>(async () => undefined),
      stop: vi.fn<() => Promise<void>>(async () => undefined),
    };
    const lifecycle = new RunManagerLifecycle(runtime);
    await lifecycle.start();
    void lifecycle.track(() => active.promise);

    const stopping = lifecycle.stop();
    expect(lifecycle.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(managerStopGraceMs - 1);
    expect(runtime.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.stop).toHaveBeenCalledOnce();
    await expect(stopping).resolves.toBeUndefined();
    active.resolve();
  });

  it('bounds the shutdown response while cleanup continues and permits relaunch only after fulfilment', async () => {
    const shutdown = deferred();
    const runtime = {
      start: vi.fn<() => Promise<void>>(async () => undefined),
      stop: vi.fn<() => Promise<void>>(() => shutdown.promise),
    };
    const lifecycle = new RunManagerLifecycle(runtime);
    await lifecycle.start();

    const stopping = lifecycle.stop();
    const stopped = stopping.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(managerShutdownResponseMs);
    expect(await stopped).toMatchObject({ code: 'manager_stop_failed' });
    expect(() => lifecycle.assertRunning()).toThrowError('Run manager is not started.');

    const restarting = lifecycle.start();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(runtime.start).toHaveBeenCalledOnce();
    shutdown.resolve();
    await expect(restarting).resolves.toBeUndefined();
    expect(runtime.start).toHaveBeenCalledTimes(2);
  });

  it('shares a terminal shutdown failure without retrying cleanup or reopening APIs', async () => {
    const runtime = {
      start: vi.fn<() => Promise<void>>(async () => undefined),
      stop: vi.fn<() => Promise<void>>(async () => {
        throw new Error('partial SDK cleanup failure');
      }),
    };
    const lifecycle = new RunManagerLifecycle(runtime);
    await lifecycle.start();

    await expect(lifecycle.stop()).rejects.toMatchObject({ code: 'manager_stop_failed' });
    await expect(lifecycle.stop()).rejects.toMatchObject({ code: 'manager_stop_failed' });
    await expect(lifecycle.start()).rejects.toMatchObject({ code: 'manager_start_failed' });
    expect(() => lifecycle.assertRunning()).toThrowError('Run manager is not started.');
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.start).toHaveBeenCalledOnce();
  });

  it('does not retain a losing real deadline timer after immediate shutdown', () => {
    vi.useRealTimers();
    const source = [
      "import { RunManagerLifecycle } from './src/manager/run-manager-lifecycle.ts';",
      'const lifecycle = new RunManagerLifecycle({ start: async () => undefined, stop: async () => undefined });',
      'await lifecycle.start();',
      'await lifecycle.stop();',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 1_500,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
