import { vi } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { RunManager, RunStatus } from '../../src/index.js';
import { testDatabaseUrl } from './test-environment.js';

export const startTestRunManager = async (): Promise<RunManager> => {
  const manager = createRunManager({ database: { url: testDatabaseUrl() } });
  await manager.start();
  return manager;
};

export const waitForRunStatus = async (
  manager: RunManager,
  runId: string,
  status: RunStatus,
): Promise<void> => {
  await vi.waitFor(async () => {
    const run = await manager.getRun(runId);
    if (run?.status !== status) {
      throw new Error(`Run ${runId} has not reached ${status}.`);
    }
  });
};
