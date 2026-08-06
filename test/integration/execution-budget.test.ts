import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunManager } from '../../src/index.js';
import type { RunEvent, RunExecutor, RunManager } from '../../src/index.js';
import { agentBinding, end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';
import { waitForRunStatus } from '../support/run-manager.fixture.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

describe('execution budget', () => {
  it('does not dispatch a task after the plan-wide execution limit is exhausted', async () => {
    const dispatched: string[] = [];
    const executor: RunExecutor = {
      execute: async ({ path }) => {
        dispatched.push(path);
        return { kind: 'completed', outcome: 'completed' };
      },
    };
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor,
    });
    await manager.start();

    const runId = `budget-${randomUUID()}`;
    await manager.startRun({
      runId,
      executionPlan: executionPlan(sequence(task('first'), task('second'), end('succeeded')), {
        bindings: [agentBinding('first', 'worker'), agentBinding('second', 'worker')],
        policies: { maximumTotalNodeExecutions: 1 },
      }),
      input: null,
    });
    await waitForRunStatus(manager, runId, 'failed');

    expect(dispatched).toEqual(['main/first']);
    await expect(manager.getRun(runId)).resolves.toMatchObject({
      status: 'failed',
      result: { outcome: 'invalid' },
    });

    const events: RunEvent[] = [];
    for await (const event of manager.subscribeRunEvents(runId)) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'pipeline.invalidState',
        path: 'main/second',
        errorCode: 'maximum_total_node_executions_exceeded',
      }),
    );
  });
});
