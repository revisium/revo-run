import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isNodeEffectDecisionStepName } from '../../src/dbos/dbos-names.js';
import { scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import { createRunManager } from '../../src/index.js';
import type {
  RunEvent,
  RunExecutor,
  RunExecutorRequest,
  RunExecutorResult,
  RunManager,
} from '../../src/index.js';
import {
  agentBinding,
  end,
  executionPlan,
  retryPolicy,
  routeOutcomes,
  task,
} from '../dsl/pipeline-builder.js';
import { RetryBackoffRecords } from '../support/process/retry-backoff-records.js';
import { waitForRunStatus } from '../support/run-manager.fixture.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

const collectEvents = async (runManager: RunManager, runId: string): Promise<RunEvent[]> => {
  const events: RunEvent[] = [];
  for await (const event of runManager.subscribeRunEvents(runId)) {
    events.push(event);
  }
  return events;
};

const retryingTaskPlan = () =>
  executionPlan(
    routeOutcomes(task('work', { retry: retryPolicy() }), {
      completed: end('succeeded'),
      failed: end('failed'),
    }),
    { bindings: [agentBinding('work', 'worker')] },
  );

describe('task retry', () => {
  it('records ordered attempts around a durable backoff', async () => {
    const requests: RunExecutorRequest[] = [];
    const startedAt: number[] = [];
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: {
        async execute(request) {
          requests.push(request);
          startedAt.push(Date.now());
          return request.attemptOrdinal === 1
            ? {
                kind: 'failed' as const,
                error: { code: 'rate_limited', message: 'retry later' },
              }
            : { kind: 'completed' as const, outcome: 'completed' };
        },
      },
    });
    await manager.start();
    const runId = `retry-${randomUUID()}`;

    await manager.startRun({
      runId,
      executionPlan: executionPlan(
        routeOutcomes(
          task('work', {
            retry: retryPolicy({
              maximumAttempts: 3,
              backoff: { kind: 'constant', delayMs: 50 },
            }),
          }),
          { completed: end('succeeded'), failed: end('failed') },
        ),
        { bindings: [agentBinding('work', 'worker')] },
      ),
      input: null,
    });
    await waitForRunStatus(manager, runId, 'succeeded');

    expect(requests.map(({ attemptOrdinal }) => attemptOrdinal)).toStrictEqual([1, 2]);
    expect(requests[0]?.attemptId).not.toBe(requests[1]?.attemptId);
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(40);

    const scopeId = requests[0]?.scopeId;
    expect(scopeId).toBeDefined();
    const steps = await DBOS.listWorkflowSteps(scopeWorkflowId(scopeId ?? ''));
    expect(
      steps?.filter(({ name }) => isNodeEffectDecisionStepName(name)).map(({ name }) => name),
    ).toStrictEqual(['node-effect-decision:1:main/work', 'node-effect-decision:2:main/work']);

    await expect(manager.getRunDetails(runId)).resolves.toMatchObject({
      nodeInstances: [
        expect.objectContaining({
          status: 'completed',
          attemptIds: [requests[0]?.attemptId, requests[1]?.attemptId],
        }),
      ],
      attempts: [
        expect.objectContaining({
          id: requests[0]?.attemptId,
          ordinal: 1,
          status: 'failed',
          error: { code: 'rate_limited' },
        }),
        expect.objectContaining({
          id: requests[1]?.attemptId,
          ordinal: 2,
          status: 'completed',
        }),
      ],
    });
    const events = await collectEvents(manager, runId);
    expect(events.map(({ type }) => type)).toStrictEqual([
      'nodeExecution.started',
      'nodeExecution.failed',
      'nodeExecution.started',
      'nodeExecution.completed',
      'run.completed',
    ]);
  });

  it('does not retry a checkpointed input-resolution failure', async () => {
    const requests: RunExecutorRequest[] = [];
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: {
        async execute(request) {
          requests.push(request);
          return {
            kind: 'inputResolutionFailed' as const,
            error: { code: 'rate_limited', message: 'resolution failed' },
          };
        },
      },
    });
    await manager.start();
    const runId = `retry-input-resolution-${randomUUID()}`;

    await manager.startRun({
      runId,
      executionPlan: executionPlan(
        routeOutcomes(task('work', { retry: retryPolicy() }), {
          failed: end('failed'),
        }),
        { bindings: [agentBinding('work', 'worker')] },
      ),
      input: null,
    });
    await waitForRunStatus(manager, runId, 'failed');

    expect(requests).toHaveLength(1);
    await expect(manager.getRunDetails(runId)).resolves.toMatchObject({
      attempts: [
        expect.objectContaining({
          ordinal: 1,
          status: 'failed',
          error: { code: 'rate_limited' },
        }),
      ],
    });
    const events = await collectEvents(manager, runId);
    expect(events.map(({ type }) => type)).toStrictEqual([
      'nodeExecution.started',
      'inputResolution.failed',
      'nodeExecution.failed',
      'run.failed',
    ]);
  });

  it('cancels the owning scope during backoff without dispatching a late attempt', async () => {
    const requests: RunExecutorRequest[] = [];
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: {
        async execute(request) {
          requests.push(request);
          return {
            kind: 'failed' as const,
            error: { code: 'rate_limited', message: 'retry later' },
          };
        },
      },
    });
    await manager.start();
    const records = await RetryBackoffRecords.connect();
    const runId = `retry-cancel-${randomUUID()}`;

    try {
      await manager.startRun({
        runId,
        executionPlan: executionPlan(
          routeOutcomes(
            task('work', {
              retry: retryPolicy({
                maximumAttempts: 3,
                backoff: { kind: 'constant', delayMs: 2_000 },
              }),
            }),
            { completed: end('succeeded'), failed: end('failed') },
          ),
          { bindings: [agentBinding('work', 'worker')] },
        ),
        input: null,
      });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const scopeId = requests[0]?.scopeId;
      expect(scopeId).toBeDefined();
      const owningWorkflowId = scopeWorkflowId(scopeId ?? '');
      const sleep = await records.waitForPositiveDurationSleep(runId);
      await expect(DBOS.getWorkflowStatus(owningWorkflowId)).resolves.toMatchObject({
        status: 'PENDING',
      });

      const cancellationStartedAt = Date.now();
      await expect(manager.cancelRun({ runId, actorId: 'task-retry-test' })).resolves.toMatchObject(
        { status: 'accepted' },
      );
      await waitForRunStatus(manager, runId, 'cancelled');
      expect(Date.now() - cancellationStartedAt).toBeLessThan(1_000);
      const operationsAtSettlement = await records.operationsForRun(runId);

      await wait(Math.max(0, sleep.deadlineEpochMs - Date.now() + 100));
      expect(requests.map(({ attemptOrdinal }) => attemptOrdinal)).toStrictEqual([1]);
      const operationsAfterDeadline = await records.operationsForRun(runId);
      expect(operationsAfterDeadline).toStrictEqual(operationsAtSettlement);
      expect(
        operationsAfterDeadline.filter(({ name }) => name === 'node-effect-decision:2:main/work'),
      ).toStrictEqual([]);

      const events = await collectEvents(manager, runId);
      expect(
        events.flatMap((event) =>
          event.type === 'nodeExecution.started' ? [event.data.attemptOrdinal] : [],
        ),
      ).toStrictEqual([1]);
      expect(events.map(({ type }) => type)).toStrictEqual([
        'nodeExecution.started',
        'nodeExecution.failed',
        'runCommand.accepted',
      ]);
    } finally {
      await records.close();
    }
  }, 10_000);

  it('redacts a thrown step failure without retrying or synthesizing terminal events', async () => {
    let executionCount = 0;
    const executor: RunExecutor = {
      async execute() {
        executionCount += 1;
        throw new Error('secret provider detail');
      },
    };
    manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
    await manager.start();
    const runId = `retry-thrown-${randomUUID()}`;

    await manager.startRun({ runId, executionPlan: retryingTaskPlan(), input: null });
    await waitForRunStatus(manager, runId, 'failed');

    const run = await manager.getRun(runId);
    const details = await manager.getRunDetails(runId);
    const events = await collectEvents(manager, runId);
    expect(executionCount).toBe(1);
    expect(run).toMatchObject({
      status: 'failed',
      error: { code: 'workflow_failed', message: 'Workflow execution failed.' },
    });
    expect(details).toMatchObject({
      attempts: [expect.objectContaining({ status: 'failed', error: { code: 'step_failed' } })],
    });
    expect(events.map(({ type }) => type)).toStrictEqual(['nodeExecution.started']);
    expect(JSON.stringify({ run, details, events })).not.toContain('secret provider detail');
  });

  it('rejects an invalid step result without retrying or exposing its payload', async () => {
    let executionCount = 0;
    const invalidResult: RunExecutorResult = { kind: 'completed', outcome: 'valid' };
    Object.defineProperties(invalidResult, {
      outcome: { enumerable: true, value: 42 },
      secret: { enumerable: true, value: 'invalid payload' },
    });
    const executor: RunExecutor = {
      async execute() {
        executionCount += 1;
        return invalidResult;
      },
    };
    manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
    await manager.start();
    const runId = `retry-invalid-result-${randomUUID()}`;

    await manager.startRun({ runId, executionPlan: retryingTaskPlan(), input: null });
    await waitForRunStatus(manager, runId, 'failed');

    const run = await manager.getRun(runId);
    const details = await manager.getRunDetails(runId);
    const events = await collectEvents(manager, runId);
    expect(executionCount).toBe(1);
    expect(run).toMatchObject({
      status: 'failed',
      error: { code: 'workflow_failed', message: 'Workflow execution failed.' },
    });
    expect(details).toMatchObject({
      attempts: [expect.objectContaining({ status: 'failed', error: { code: 'step_failed' } })],
    });
    expect(events.map(({ type }) => type)).toStrictEqual(['nodeExecution.started']);
    expect(JSON.stringify({ run, details, events })).not.toContain('invalid payload');
  });
});
