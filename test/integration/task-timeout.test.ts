import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { RunEvent, RunExecutor, RunManager } from '../../src/index.js';
import { agentBinding, end, executionPlan, routeOutcomes, task } from '../dsl/pipeline-builder.js';
import { waitForRunStatus } from '../support/run-manager.fixture.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe('task timeout', () => {
  it('signals the executor and routes the task through its timed-out outcome', async () => {
    let timeoutObserved = false;
    const executor: RunExecutor = {
      execute: async (_request, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            timeoutObserved = true;
          });
          void resolve;
        }),
    };
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor,
    });
    await manager.start();

    const runId = `timeout-${randomUUID()}`;
    await manager.startRun({
      runId,
      executionPlan: executionPlan(
        routeOutcomes(task('work', { timeoutMs: 25 }), {
          completed: end('succeeded'),
          timedOut: end('failed', { outcome: 'timedOut' }),
        }),
        { bindings: [agentBinding('work', 'worker')] },
      ),
      input: null,
    });
    await waitForRunStatus(manager, runId, 'failed');

    const events: RunEvent[] = [];
    for await (const event of manager.subscribeRunEvents(runId)) {
      events.push(event);
    }
    expect(timeoutObserved).toBe(true);
    const run = await manager.getRun(runId);
    expect(run).toMatchObject({
      status: 'failed',
      result: { outcome: 'timedOut' },
    });
    expect(run !== undefined && 'error' in run ? run.error : undefined).toBeUndefined();
    await expect(manager.getRunDetails(runId)).resolves.toMatchObject({
      nodeInstances: [expect.objectContaining({ status: 'timedOut' })],
      attempts: [expect.objectContaining({ status: 'timedOut' })],
    });
    const timedOutEvent = events.find(({ type }) => type === 'nodeExecution.timedOut');
    assert(timedOutEvent?.type === 'nodeExecution.timedOut');
    expect(timedOutEvent.data.attemptOrdinal).toBe(1);
  });
});
