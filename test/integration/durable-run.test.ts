import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunManager, RunManagerError } from '../../src/index.js';
import type { RunExecutorRequest, RunManager } from '../../src/index.js';
import { parseRunWorkflowInput } from '../../src/validation/parse-run-workflow-data.js';
import { taskExecutionPlan, terminalExecutionPlan } from '../support/execution-plan.fixture.js';
import { startTestRunManager, waitForRunStatus } from '../support/run-manager.fixture.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager;

const isRunIdConflict = (value: unknown): value is RunManagerError =>
  value instanceof RunManagerError && value.code === 'run_id_conflict';

const runConcurrentIdenticalAdmissionScenario = async () => {
  await manager.stop();
  let effects = 0;
  manager = createRunManager({
    database: { url: testDatabaseUrl() },
    executor: {
      async execute() {
        effects += 1;
        return { kind: 'completed', outcome: 'completed' };
      },
    },
  });
  await manager.start();
  const runId = `duplicate-identical-race-${randomUUID()}`;
  const admission = { runId, executionPlan: taskExecutionPlan(), input: null } as const;
  const results = await Promise.allSettled([
    manager.startRun(admission),
    manager.startRun(admission),
  ]);
  await waitForRunStatus(manager, runId, 'failed');

  return {
    details: await manager.getRunDetails(runId),
    effects,
    results,
    runId,
  };
};

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

  it('rejects an identical duplicate admission because start is create-only', async () => {
    const runId = `duplicate-${randomUUID()}`;
    const input = {
      runId,
      executionPlan: terminalExecutionPlan(),
      input: null,
    } as const;

    await manager.startRun(input);

    await expect(manager.startRun(input)).rejects.toMatchObject({
      code: 'run_id_conflict',
      message: 'Run ID is already claimed.',
    });
  });

  it('reports a typed conflict for a duplicate run ID with different input', async () => {
    const runId = `duplicate-conflict-${randomUUID()}`;
    const executionPlan = terminalExecutionPlan();

    await manager.startRun({ runId, executionPlan, input: { value: 1 } });

    await expect(
      manager.startRun({ runId, executionPlan, input: { value: 2 } }),
    ).rejects.toMatchObject({
      name: 'RunManagerError',
      code: 'run_id_conflict',
      message: 'Run ID is already claimed.',
    });
  });

  it('reports exactly one success for concurrent different-input admission', async () => {
    const runId = `duplicate-race-${randomUUID()}`;
    const executionPlan = terminalExecutionPlan();
    const first = { runId, executionPlan, input: { contender: 'first' } } as const;
    const second = { runId, executionPlan, input: { contender: 'second' } } as const;

    const results = await Promise.allSettled([manager.startRun(first), manager.startRun(second)]);
    const fulfilled = results.filter(({ status }) => status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isRunIdConflict(rejected[0]?.reason)).toBe(true);

    const durable = await manager.getRun(runId);
    expect(durable).toBeDefined();
    const firstWon = JSON.stringify(durable?.input) === JSON.stringify(first.input);
    const loser = firstWon ? second : first;
    const winner = firstWon ? first : second;

    await expect(manager.startRun(winner)).rejects.toMatchObject({ code: 'run_id_conflict' });
    await expect(manager.startRun(loser)).rejects.toMatchObject({ code: 'run_id_conflict' });
  });

  it('admits one concurrent identical start and records exactly one durable effect', async () => {
    const { details, effects, results } = await runConcurrentIdenticalAdmissionScenario();

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(isRunIdConflict(rejected[0]?.reason)).toBe(true);
    expect(effects).toBe(1);
    expect(details?.nodeInstances).toHaveLength(1);
    expect(details?.attempts).toHaveLength(1);
  });

  it('keeps the valid admission token private across observation surfaces', async () => {
    const { details, runId } = await runConcurrentIdenticalAdmissionScenario();

    const rootWorkflowId = `rr:run:v1:${runId}`;
    const durableStatus = await DBOS.getWorkflowStatus(rootWorkflowId);
    expect(durableStatus?.workflowID).toBe(rootWorkflowId);
    expect(rootWorkflowId).toContain(':');
    const durableInput = parseRunWorkflowInput(durableStatus?.input);
    expect(durableInput.admissionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const events = [];
    for await (const event of manager.subscribeRunEvents(runId)) {
      events.push(event);
    }
    expect(JSON.stringify({ run: await manager.getRun(runId), details, events })).not.toContain(
      durableInput.admissionToken,
    );
  });

  it('recovers a real durable commit after admission confirmation becomes ambiguous', async () => {
    const runId = `ambiguous-commit-${randomUUID()}`;
    const rootWorkflowId = `rr:run:v1:${runId}`;
    const getWorkflowStatus = DBOS.getWorkflowStatus.bind(DBOS);
    let rootStatusReads = 0;
    const statusSpy = vi.spyOn(DBOS, 'getWorkflowStatus').mockImplementation(async (workflowId) => {
      if (workflowId === rootWorkflowId) {
        rootStatusReads += 1;
        if (rootStatusReads === 2) {
          return null;
        }
      }
      return getWorkflowStatus(workflowId);
    });

    try {
      await expect(
        manager.startRun({ runId, executionPlan: terminalExecutionPlan(), input: null }),
      ).rejects.toMatchObject({ code: 'run_admission_failed' });
    } finally {
      statusSpy.mockRestore();
    }

    await waitForRunStatus(manager, runId, 'succeeded');
    await expect(manager.getRun(runId)).resolves.toMatchObject({ id: runId, status: 'succeeded' });
    await expect(
      manager.startRun({ runId, executionPlan: terminalExecutionPlan(), input: null }),
    ).rejects.toMatchObject({ code: 'run_id_conflict' });
  });

  it('rejects a missing root pipeline before durable admission', async () => {
    const runId = `missing-root-${randomUUID()}`;
    const executionPlan = {
      ...terminalExecutionPlan(),
      rootPipelineId: 'missing',
    };

    await expect(manager.startRun({ runId, executionPlan, input: null })).rejects.toMatchObject({
      code: 'root_pipeline_not_found',
    });
    await expect(manager.getRun(runId)).resolves.toBeUndefined();
  });

  it('rejects a missing task binding before durable admission', async () => {
    const runId = `missing-binding-${randomUUID()}`;
    const executionPlan = {
      ...taskExecutionPlan(),
      bindings: [],
    };

    await expect(manager.startRun({ runId, executionPlan, input: null })).rejects.toMatchObject({
      code: 'missing_executor_binding',
    });
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

  it('delivers distinct opaque execution identities to the executor boundary', async () => {
    await manager.stop();
    let captured: RunExecutorRequest | undefined;
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: {
        async execute(request) {
          captured = request;
          return { kind: 'completed', outcome: 'completed' };
        },
      },
    });
    await manager.start();
    const runId = `identity-${randomUUID()}`;

    await manager.startRun({ runId, executionPlan: taskExecutionPlan(), input: null });
    await waitForRunStatus(manager, runId, 'failed');

    expect(captured).toMatchObject({
      runId,
      attemptOrdinal: 1,
      displayPath: 'main/work',
      pipelineId: 'main',
      nodePath: 'work',
    });
    expect(captured?.authoredNodeId).toMatch(/^an1_[A-Za-z0-9_-]{43}$/);
    expect(captured?.scopeId).toMatch(/^sc1_[A-Za-z0-9_-]{43}$/);
    expect(captured?.nodeInstanceId).toMatch(/^ni1_[A-Za-z0-9_-]{43}$/);
    expect(captured?.attemptId).toMatch(/^at1_[A-Za-z0-9_-]{43}$/);
    expect(
      new Set([
        captured?.authoredNodeId,
        captured?.scopeId,
        captured?.nodeInstanceId,
        captured?.attemptId,
      ]).size,
    ).toBe(4);
  });

  it('returns undefined for an unknown run', async () => {
    await expect(manager.getRun(`missing-${randomUUID()}`)).resolves.toBeUndefined();
  });
});
