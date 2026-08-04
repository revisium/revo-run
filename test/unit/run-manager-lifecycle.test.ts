import { describe, expect, it, vi } from 'vitest';

import { createRunManagerWithRuntimeFactory } from '../../src/manager/create-run-manager.js';
import { acquireProcessManagerOwnership } from '../../src/manager/process-manager-ownership.js';
import { RunManagerController } from '../../src/manager/run-manager.js';
import type { RunSnapshot } from '../../src/types.js';
import { FakeRunSnapshotStore } from '../support/fake-run-snapshot-store.js';
import {
  FakeProcessManagerOwnership,
  FakeWorkflowRuntime,
} from '../support/fake-workflow-runtime.js';

const snapshots = {
  create: async (): Promise<void> => undefined,
  update: async (): Promise<void> => undefined,
  get: async (): Promise<RunSnapshot | undefined> => undefined,
};

const managerFixture = (
  snapshotStore = snapshots,
): {
  manager: RunManagerController;
  ownership: FakeProcessManagerOwnership;
  runtime: FakeWorkflowRuntime;
} => {
  const runtime = new FakeWorkflowRuntime();
  const ownership = new FakeProcessManagerOwnership();
  return {
    manager: new RunManagerController(runtime, ownership, snapshotStore),
    ownership,
    runtime,
  };
};

describe('run manager lifecycle', () => {
  it('serializes concurrent starts and stops, then disposes exactly once', async () => {
    const { manager, ownership, runtime } = managerFixture();

    await Promise.all([manager.start(), manager.start()]);
    expect(runtime.configureCalls()).toBe(1);
    expect(runtime.launchCalls()).toBe(1);

    await Promise.all([manager.stop(), manager.stop()]);
    expect(runtime.shutdownCalls()).toBe(1);
    expect(runtime.disposeCalls()).toBe(1);
    expect(ownership.releaseCalls()).toBe(1);
  });

  it('does not dispose or release while shutdown is in progress', async () => {
    const { manager, ownership, runtime } = managerFixture();
    runtime.deferShutdown();
    await manager.start();

    const stop = manager.stop();
    await vi.waitFor(() => expect(runtime.shutdownCalls()).toBe(1));
    expect(runtime.disposeCalls()).toBe(0);
    expect(ownership.isReleased()).toBe(false);

    runtime.completeShutdown();
    await stop;
    expect(runtime.disposeCalls()).toBe(1);
    expect(ownership.isReleased()).toBe(true);
  });

  it('allows stop to complete while admission acknowledgement is pending', async () => {
    const { manager, runtime } = managerFixture();
    runtime.deferAdmission();
    await manager.start();

    const admission = manager.startRun({
      planPin: { id: 'p', revision: '1', digest: 'd' },
      input: null,
    });
    await vi.waitFor(() => expect(runtime.hasPendingAdmission()).toBe(true));

    await manager.stop();
    expect(runtime.shutdownCalls()).toBe(1);

    runtime.completeAdmission();
    await expect(admission).resolves.toMatchObject({ status: 'pending' });
  });

  it('keeps ownership after launch failure until stop disposes the manager', async () => {
    const { manager, ownership, runtime } = managerFixture();
    runtime.failNextLaunch();

    await expect(manager.start()).rejects.toThrow('launch failed');
    expect(ownership.isReleased()).toBe(false);

    await manager.stop();
    expect(ownership.isReleased()).toBe(true);
  });

  it('keeps ownership after shutdown failure until shutdown retry succeeds', async () => {
    const { manager, ownership, runtime } = managerFixture();
    await manager.start();
    runtime.failNextShutdown();

    await expect(manager.stop()).rejects.toThrow('shutdown failed');
    expect(ownership.isReleased()).toBe(false);
    await expect(manager.start()).rejects.toThrow('shutdown state is uncertain');

    await manager.stop();
    expect(ownership.isReleased()).toBe(true);
  });

  it('rejects operations after disposal', async () => {
    const { manager } = managerFixture();
    await manager.stop();

    await expect(manager.start()).rejects.toThrow('Run manager has been stopped.');
    await expect(
      manager.startRun({ planPin: { id: 'p', revision: '1', digest: 'd' }, input: null }),
    ).rejects.toThrow('Run manager is not started.');
  });

  it('rejects reads after disposal', async () => {
    const { manager } = managerFixture();
    await manager.start();
    await manager.stop();

    await expect(manager.getRun('run-id')).rejects.toThrow('Run manager is not started.');
  });

  it('allows stop to complete while an initiated snapshot read is pending', async () => {
    const snapshotStore = new FakeRunSnapshotStore();
    snapshotStore.deferNextGet();
    const { manager, runtime } = managerFixture(snapshotStore);
    const expected: RunSnapshot = {
      id: 'run-id',
      planPin: { id: 'p', revision: '1', digest: 'd' },
      input: null,
      status: 'succeeded',
      result: null,
      error: null,
    };
    await manager.start();

    const read = manager.getRun('run-id');
    await vi.waitFor(() => expect(snapshotStore.isGetPending()).toBe(true));

    await manager.stop();
    expect(runtime.shutdownCalls()).toBe(1);
    expect(snapshotStore.isGetPending()).toBe(true);

    snapshotStore.completeGet(expected);
    await expect(read).resolves.toEqual(expected);
  });

  it('propagates snapshot read rejection', async () => {
    const snapshotStore = new FakeRunSnapshotStore();
    snapshotStore.failNextGet();
    const { manager } = managerFixture(snapshotStore);
    await manager.start();

    const read = manager.getRun('run-id');

    await expect(read).rejects.toThrow('snapshot read failed');
    await manager.stop();
  });
});

describe('process manager ownership', () => {
  it('returns a frozen public facade with closure-bound methods only', async () => {
    const runtime = new FakeWorkflowRuntime();
    const manager = createRunManagerWithRuntimeFactory(
      {
        database: { url: 'postgresql://test' },
        plans: { loadExact: async () => ({ compiledPipeline: null }) },
        executor: { execute: async () => ({ outcome: 'completed' }) },
        snapshots,
      },
      () => runtime,
    );

    expect(Object.keys(manager)).toEqual(['start', 'stop', 'startRun', 'getRun']);
    expect(Object.isFrozen(manager)).toBe(true);
    expect(Reflect.set(manager, 'state', 'started')).toBe(false);
    expect(Reflect.deleteProperty(manager, 'start')).toBe(false);

    await manager.start.call(undefined);
    expect(runtime.launchCalls()).toBe(1);

    await manager.stop();
  });

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
