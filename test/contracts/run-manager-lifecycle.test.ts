import { DBOS, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DefaultRunManager } from '../../src/manager/run-manager.js';

const options = {
  database: { url: 'postgresql://unused' },
  host: {
    resources: { inspect: async () => undefined },
    workspaces: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('Lifecycle tests do not acquire a workspace.');
      },
    },
    credentials: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('Lifecycle tests do not acquire credentials.');
      },
    },
  },
} as const;

const fatalStatus = (runId: string): WorkflowStatus => ({
  workflowID: `revo-run:${runId}`,
  workflowName: 'revo-run.kernel-host/v1',
  workflowClassName: '',
  applicationID: 'revo-run-test',
  status: 'ERROR',
  createdAt: 1,
  updatedAt: 2,
  priority: 0,
});

const runningManager = (): DefaultRunManager => {
  const manager = new DefaultRunManager(options);
  Reflect.set(manager, 'lifecycle', 'running');
  return manager;
};

afterEach(() => vi.restoreAllMocks());

describe('RN1 run-manager stop lifecycle', () => {
  it('stops accepting new calls, drains an active read, then shuts DBOS down once', async () => {
    const manager = runningManager();
    let resolveStatus: ((status: WorkflowStatus) => void) | undefined;
    const pendingStatus = new Promise<WorkflowStatus>((resolve) => {
      resolveStatus = resolve;
    });
    const status = vi
      .spyOn(DBOS, 'getWorkflowStatus')
      .mockImplementation(async () => pendingStatus);
    const shutdown = vi.spyOn(DBOS, 'shutdown').mockResolvedValue(undefined);

    const activeRead = manager.getRun('rn1-lifecycle-active');
    await expect.poll(() => status.mock.calls.length).toBe(1);

    const firstStop = manager.stop();
    const secondStop = manager.stop();
    await expect(manager.getRun('rn1-lifecycle-new')).rejects.toMatchObject({
      code: 'manager_not_started',
      details: { lifecycle: 'stopping' },
    });
    expect(shutdown).not.toHaveBeenCalled();

    if (resolveStatus === undefined) {
      throw new Error('Expected the active status read.');
    }
    resolveStatus(fatalStatus('rn1-lifecycle-active'));
    await expect(activeRead).resolves.toMatchObject({ status: 'failed' });
    await Promise.all([firstStop, secondStop]);

    expect(shutdown).toHaveBeenCalledOnce();
    await expect(manager.getRun('rn1-lifecycle-stopped')).rejects.toMatchObject({
      code: 'manager_not_started',
      details: { lifecycle: 'stopped' },
    });
  });
});
