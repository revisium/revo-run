import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunManager } from '../../src/index.js';
import { taskExecutionPlan, terminalExecutionPlan } from '../support/execution-plan.fixture.js';
import { startTestRunManager, waitForRunStatus } from '../support/run-manager.fixture.js';

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

  it('rejects a missing root pipeline before durable admission', async () => {
    const runId = `missing-root-${randomUUID()}`;
    const executionPlan = {
      ...terminalExecutionPlan(),
      rootPipelineId: 'missing',
    };

    await expect(manager.startRun({ runId, executionPlan, input: null })).rejects.toThrow(
      'root_pipeline_not_found',
    );
    await expect(manager.getRun(runId)).resolves.toBeUndefined();
  });

  it('rejects a missing task binding before durable admission', async () => {
    const runId = `missing-binding-${randomUUID()}`;
    const executionPlan = {
      ...taskExecutionPlan(),
      bindings: [],
    };

    await expect(manager.startRun({ runId, executionPlan, input: null })).rejects.toThrow(
      'missing_executor_binding',
    );
    await expect(manager.getRun(runId)).resolves.toBeUndefined();
  });

  it('reports a pipeline without a terminal route as failed', async () => {
    const runId = `unsupported-${randomUUID()}`;

    await manager.startRun({
      runId,
      executionPlan: taskExecutionPlan(),
      input: null,
    });
    await waitForRunStatus(manager, runId, 'failed');

    await expect(manager.getRun(runId)).resolves.toMatchObject({
      status: 'failed',
      result: { outcome: 'invalid' },
    });
  });

  it('returns undefined for an unknown run', async () => {
    await expect(manager.getRun(`missing-${randomUUID()}`)).resolves.toBeUndefined();
  });
});
