import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWorkflowId } from '../../src/dbos/workflow-id.js';
import { createRunManager } from '../../src/index.js';
import type { RunManager } from '../../src/index.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { waitForRunStatus } from '../support/run-manager.fixture.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const foreignWorkflow = DBOS.registerWorkflow(async (value: string) => value, {
  name: 'revo-run.test.foreign-observation.v1',
});

const activePlan = () =>
  executionPlan(sequence(task('work'), end('succeeded')), {
    bindings: [agentBinding('work', 'worker')],
  });

let manager: RunManager | undefined;

const startObservationManager = async (executor = new ControlledRunExecutor()) => {
  const started = createRunManager({
    database: { url: testDatabaseUrl() },
    executor,
  });
  await started.start();
  manager = started;
  return { manager: started, executor };
};

const startActiveRunObservationScenario = async (runIdPrefix: string) => {
  const { manager: runManager, executor } = await startObservationManager();
  const runId = `${runIdPrefix}-${randomUUID()}`;
  let executionReleased = false;

  await runManager.startRun({ runId, executionPlan: activePlan(), input: null });
  await executor.expectStarted('main/work');

  const finish = async (): Promise<void> => {
    if (!executionReleased) {
      await executor.complete('main/work', { kind: 'completed', outcome: 'completed' });
      executionReleased = true;
    }
    await waitForRunStatus(runManager, runId, 'succeeded');
  };

  return { finish, manager: runManager, runId };
};

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe.sequential('real DBOS run observation', () => {
  it('filters run listings by creation dates and status', async () => {
    const createdFrom = new Date(Date.now() - 1_000);
    const scenario = await startActiveRunObservationScenario('list-running');
    const runManager = scenario.manager;

    try {
      const future = new Date(Date.now() + 60_000);
      await expect(runManager.listRuns({ createdFrom: future })).resolves.toEqual({ items: [] });

      const succeededRunId = `list-succeeded-${randomUUID()}`;
      await runManager.startRun({
        runId: succeededRunId,
        executionPlan: terminalExecutionPlan(),
        input: null,
      });
      await waitForRunStatus(runManager, succeededRunId, 'succeeded');
      const createdThrough = new Date(Date.now() + 1_000);

      const running = await runManager.listRuns({
        statuses: ['running'],
        createdFrom,
        createdThrough,
        limit: 100,
      });
      expect(running.items.map(({ id }) => id)).toContain(scenario.runId);
      expect(running.items.every(({ status }) => status === 'running')).toBe(true);

      const succeeded = await runManager.listRuns({
        statuses: ['succeeded'],
        createdFrom,
        createdThrough,
        limit: 100,
      });
      expect(succeeded.items.map(({ id }) => id)).toContain(succeededRunId);
      expect(succeeded.items.every(({ status }) => status === 'succeeded')).toBe(true);
    } finally {
      await scenario.finish();
    }
  });

  it('continues a run listing from the raw DBOS offset', async () => {
    const { manager: runManager } = await startObservationManager();
    const createdFrom = new Date(Date.now() - 1_000);
    const firstSucceeded = `list-offset-a-${randomUUID()}`;
    const secondSucceeded = `list-offset-b-${randomUUID()}`;
    await runManager.startRun({
      runId: firstSucceeded,
      executionPlan: terminalExecutionPlan(),
      input: null,
    });
    await runManager.startRun({
      runId: secondSucceeded,
      executionPlan: terminalExecutionPlan(),
      input: null,
    });
    await Promise.all([
      waitForRunStatus(runManager, firstSucceeded, 'succeeded'),
      waitForRunStatus(runManager, secondSucceeded, 'succeeded'),
    ]);
    const createdThrough = new Date(Date.now() + 1_000);

    const firstPage = await runManager.listRuns({
      statuses: ['succeeded'],
      createdFrom,
      createdThrough,
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    const nextOffset = firstPage.nextOffset;
    expect(nextOffset).toBeTypeOf('number');
    if (nextOffset === undefined) {
      throw new Error('Expected a raw continuation offset.');
    }
    const secondPage = await runManager.listRuns({
      statuses: ['succeeded'],
      createdFrom,
      createdThrough,
      offset: nextOffset,
      limit: 1,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    // DBOS orders by createdAt only; equal-timestamp rows remain intentionally provider-ordered.
  });

  it('returns a finite high-water page while the run stream is still active', async () => {
    const scenario = await startActiveRunObservationScenario('active-events');
    const { manager: runManager, runId } = scenario;

    try {
      await vi.waitFor(
        async () => {
          await expect(runManager.getRunEvents(runId)).resolves.toEqual({
            items: [
              expect.objectContaining({ cursor: `${runId}:1`, type: 'nodeExecution.started' }),
            ],
            nextCursor: `${runId}:1`,
            hasMore: false,
          });
        },
        { timeout: 5_000 },
      );
    } finally {
      await scenario.finish();
    }
  });

  it('continues event pages from an observed cursor', async () => {
    const scenario = await startActiveRunObservationScenario('continued-events');
    try {
      await scenario.finish();
      const firstPage = await scenario.manager.getRunEvents(scenario.runId, { limit: 1 });
      expect(firstPage).toMatchObject({
        items: [{ cursor: `${scenario.runId}:1` }],
        nextCursor: `${scenario.runId}:1`,
        hasMore: true,
      });
      const nextCursor = firstPage.nextCursor;
      if (nextCursor === undefined) {
        throw new Error('Expected an event continuation cursor.');
      }
      await expect(
        scenario.manager.getRunEvents(scenario.runId, { after: nextCursor, limit: 100 }),
      ).resolves.toMatchObject({
        items: [
          { cursor: `${scenario.runId}:2`, type: 'nodeExecution.completed' },
          { cursor: `${scenario.runId}:3`, type: 'run.completed' },
        ],
        nextCursor: `${scenario.runId}:3`,
        hasMore: false,
      });
    } finally {
      await scenario.finish();
    }
  });

  it('rejects an event cursor beyond the current high-water mark', async () => {
    const scenario = await startActiveRunObservationScenario('future-event-cursor');
    try {
      await scenario.finish();
      await expect(
        scenario.manager.getRunEvents(scenario.runId, { after: `${scenario.runId}:4` }),
      ).rejects.toMatchObject({ code: 'invalid_run_event_cursor' });
    } finally {
      await scenario.finish();
    }
  });

  it('reports a terminal wait timeout while the run remains active', async () => {
    const scenario = await startActiveRunObservationScenario('wait-timeout');
    try {
      await expect(
        scenario.manager.waitForTerminal(scenario.runId, { timeoutMs: 25 }),
      ).rejects.toMatchObject({
        code: 'run_wait_timed_out',
      });
    } finally {
      await scenario.finish();
    }
  });

  it('reports caller abort separately from a terminal wait timeout', async () => {
    const scenario = await startActiveRunObservationScenario('wait-abort');
    try {
      const controller = new AbortController();
      const aborted = scenario.manager.waitForTerminal(scenario.runId, {
        signal: controller.signal,
      });
      controller.abort();
      await expect(aborted).rejects.toMatchObject({ code: 'run_wait_aborted' });
    } finally {
      await scenario.finish();
    }
  });

  it('reports a missing run while waiting for terminal status', async () => {
    const { manager: runManager } = await startObservationManager();

    await expect(runManager.waitForTerminal(`missing-${randomUUID()}`)).rejects.toMatchObject({
      code: 'run_not_found',
    });
  });

  it('returns the authoritative terminal snapshot after the run succeeds', async () => {
    const scenario = await startActiveRunObservationScenario('wait-success');
    try {
      const terminal = scenario.manager.waitForTerminal(scenario.runId, { timeoutMs: 5_000 });
      await scenario.finish();
      await expect(terminal).resolves.toMatchObject({
        id: scenario.runId,
        status: 'succeeded',
      });
    } finally {
      await scenario.finish();
    }
  });

  it('hides a foreign mapped workflow from every observation surface', async () => {
    const { manager: runManager } = await startObservationManager();
    const runId = `foreign-${randomUUID()}`;
    const handle = await DBOS.startWorkflow(foreignWorkflow, {
      workflowID: runWorkflowId(runId),
    })('foreign');
    await handle.getResult();

    await expect(runManager.getRun(runId)).resolves.toBeUndefined();
    await expect(runManager.getRunDetails(runId)).resolves.toBeUndefined();
    await expect(runManager.getRunEvents(runId)).rejects.toMatchObject({
      code: 'run_not_found',
    });
    await expect(runManager.waitForTerminal(runId)).rejects.toMatchObject({
      code: 'run_not_found',
    });
    expect((await runManager.listRuns({ limit: 100 })).items.map(({ id }) => id)).not.toContain(
      runId,
    );
  });

  it('keeps admission create-only when a foreign workflow occupies the run ID', async () => {
    const { manager: runManager } = await startObservationManager();
    const runId = `foreign-conflict-${randomUUID()}`;
    const handle = await DBOS.startWorkflow(foreignWorkflow, {
      workflowID: runWorkflowId(runId),
    })('foreign');
    await handle.getResult();

    await expect(
      runManager.startRun({ runId, executionPlan: terminalExecutionPlan(), input: null }),
    ).rejects.toMatchObject({ code: 'run_id_conflict' });
  });
});
