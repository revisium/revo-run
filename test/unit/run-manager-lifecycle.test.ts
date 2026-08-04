import { describe, expect, it, vi } from 'vitest';

import { createRunManagerWithRuntimeFactory } from '../../src/manager/create-run-manager.js';
import { acquireProcessManagerOwnership } from '../../src/manager/process-manager-ownership.js';
import type { ProcessManagerOwnership } from '../../src/manager/process-manager-ownership.js';
import { RunManager } from '../../src/manager/run-manager.js';
import type { RunSnapshot } from '../../src/types.js';
import { FakeWorkflowRuntime } from '../support/fake-workflow-runtime.js';

const snapshots = {
  create: async (): Promise<void> => undefined,
  update: async (): Promise<void> => undefined,
  get: async (): Promise<RunSnapshot | undefined> => undefined,
};

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const managerFixture = (): {
  manager: RunManager;
  ownership: ProcessManagerOwnership & { releases: number };
  runtime: FakeWorkflowRuntime;
} => {
  const runtime = new FakeWorkflowRuntime();
  const ownership = {
    releases: 0,
    release() {
      this.releases += 1;
    },
  };
  return { manager: new RunManager(runtime, ownership, snapshots), ownership, runtime };
};

describe('run manager lifecycle', () => {
  it('serializes concurrent starts and stops, then disposes exactly once', async () => {
    const { manager, ownership, runtime } = managerFixture();

    await Promise.all([manager.start(), manager.start()]);
    expect(runtime.configureCalls).toBe(1);
    expect(runtime.launchCalls).toBe(1);

    await Promise.all([manager.stop(), manager.stop()]);
    expect(runtime.shutdownCalls).toBe(1);
    expect(runtime.disposeCalls).toBe(1);
    expect(ownership.releases).toBe(1);
  });

  it('does not dispose or release while shutdown is in progress', async () => {
    const stopping = deferred();
    const { manager, ownership, runtime } = managerFixture();
    runtime.shutdownResult = stopping.promise;
    await manager.start();

    const stop = manager.stop();
    await vi.waitFor(() => expect(runtime.shutdownCalls).toBe(1));
    expect(runtime.disposeCalls).toBe(0);
    expect(ownership.releases).toBe(0);

    stopping.resolve();
    await stop;
    expect(runtime.disposeCalls).toBe(1);
    expect(ownership.releases).toBe(1);
  });

  it('keeps ownership after failures until a completed stop', async () => {
    const startFailure = managerFixture();
    startFailure.runtime.launchResult = Promise.reject(new Error('launch failed'));
    await expect(startFailure.manager.start()).rejects.toThrow('launch failed');
    expect(startFailure.ownership.releases).toBe(0);
    await startFailure.manager.stop();
    expect(startFailure.ownership.releases).toBe(1);

    const stopFailure = managerFixture();
    await stopFailure.manager.start();
    stopFailure.runtime.shutdownResult = Promise.reject(new Error('shutdown failed'));
    await expect(stopFailure.manager.stop()).rejects.toThrow('shutdown failed');
    expect(stopFailure.ownership.releases).toBe(0);
    await expect(stopFailure.manager.start()).rejects.toThrow('shutdown state is uncertain');
    stopFailure.runtime.shutdownResult = Promise.resolve();
    await stopFailure.manager.stop();
    expect(stopFailure.ownership.releases).toBe(1);
  });

  it('rejects operations after disposal', async () => {
    const { manager } = managerFixture();
    await manager.stop();

    await expect(manager.start()).rejects.toThrow('Run manager has been stopped.');
    await expect(
      manager.startRun({ planPin: { id: 'p', revision: '1', digest: 'd' }, input: null }),
    ).rejects.toThrow('Run manager is not started.');
  });
});

describe('process manager ownership', () => {
  it('allows one owner and allows a replacement only after release', () => {
    const first = acquireProcessManagerOwnership();
    expect(() => acquireProcessManagerOwnership()).toThrow(
      'Only one run manager may be created per process.',
    );
    first.release();

    const replacement = acquireProcessManagerOwnership();
    replacement.release();
  });

  it('releases ownership when runtime construction fails', () => {
    expect(() =>
      createRunManagerWithRuntimeFactory(
        {
          database: { url: 'postgresql://test' },
          plans: { loadExact: async () => ({ compiledPipeline: null }) },
          executor: { execute: async () => ({ outcome: 'completed' }) },
          snapshots,
        },
        () => {
          throw new Error('runtime construction failed');
        },
      ),
    ).toThrow('runtime construction failed');

    const replacement = acquireProcessManagerOwnership();
    replacement.release();
  });
});
