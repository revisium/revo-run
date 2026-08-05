import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunManager } from '../../src/index.js';
import { terminalExecutionPlan } from '../support/terminal-execution-plan.js';
import { startTestRunManager, waitForRunStatus } from '../support/test-run-manager.js';

let manager: RunManager;

beforeEach(async () => {
  manager = await startTestRunManager();
});

afterEach(async () => {
  await manager.stop();
});

describe('durable run', () => {
  it('reads a completed terminal run after restarting the manager', async () => {
    const executionPlan = terminalExecutionPlan();
    const runId = `durable-${randomUUID()}`;

    await expect(
      manager.startRun({
        runId,
        executionPlan,
        input: { subject: 'example' },
      }),
    ).resolves.toEqual({ runId });
    await waitForRunStatus(manager, runId, 'succeeded');

    await manager.stop();
    await manager.start();

    await expect(manager.getRun(runId)).resolves.toMatchObject({
      id: runId,
      status: 'succeeded',
      executionPlan,
      input: { subject: 'example' },
      result: { outcome: 'succeeded' },
    });
  });

  it('rejects a duplicate run ID', async () => {
    const runId = `duplicate-${randomUUID()}`;
    const input = {
      runId,
      executionPlan: terminalExecutionPlan(),
      input: null,
    } as const;

    await manager.startRun(input);

    await expect(manager.startRun(input)).rejects.toThrow('Run ID is already in use.');
  });
});
