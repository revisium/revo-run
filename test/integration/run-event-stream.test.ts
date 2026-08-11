import { randomUUID } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { runWorkflowId } from '../../src/dbos/workflow-id.js';
import { createRunManager } from '../../src/index.js';
import type { RunEvent, RunManager } from '../../src/index.js';
import {
  agentBinding,
  end,
  executionPlan,
  routeOutcomes,
  sequence,
  task,
} from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { waitForRunStatus } from '../support/run-manager.fixture.js';
import { testDatabaseUrl } from '../support/test-environment.js';

let manager: RunManager | undefined;

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
});

const startManager = async (executor: ControlledRunExecutor): Promise<RunManager> => {
  const started = createRunManager({
    database: { url: testDatabaseUrl() },
    executor,
  });
  await started.start();
  manager = started;
  return started;
};

const collectEvents = async (runManager: RunManager, runId: string): Promise<RunEvent[]> => {
  const events: RunEvent[] = [];
  for await (const event of runManager.subscribeRunEvents(runId)) {
    events.push(event);
  }
  return events;
};

const expectStoredOrder = (events: readonly RunEvent[], runId: string): void => {
  expect(events.map(({ cursor }) => cursor)).toStrictEqual(
    events.map((_, index) => `${runId}:${index + 1}`),
  );
  expect(
    events.every(({ timestamp }) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp),
    ),
  ).toBe(true);
  expect(new Set(events.map(({ cursor }) => cursor)).size).toBe(events.length);
};

describe('real DBOS run event stream', () => {
  it('totally orders parallel child events in the single root stream', async () => {
    const executor = new ControlledRunExecutor();
    const runManager = await startManager(executor);
    const runId = `parallel-events-${randomUUID()}`;
    const parallel = {
      kind: 'parallel',
      key: 'work',
      branches: { a: task('a'), b: task('b') },
      join: {
        kind: 'all',
        successfulOutcomes: ['completed'],
        remaining: 'drain',
      },
    } as const;

    await runManager.startRun({
      runId,
      executionPlan: executionPlan(sequence(parallel, end('succeeded')), {
        bindings: [agentBinding('work/a', 'worker'), agentBinding('work/b', 'worker')],
      }),
      input: null,
    });
    await Promise.all([
      executor.expectStarted('main/work/a'),
      executor.expectStarted('main/work/b'),
    ]);
    await Promise.all([
      executor.complete('main/work/b', { kind: 'completed', outcome: 'completed' }),
      executor.complete('main/work/a', { kind: 'completed', outcome: 'completed' }),
    ]);
    await waitForRunStatus(runManager, runId, 'succeeded');

    const events = await collectEvents(runManager, runId);
    expectStoredOrder(events, runId);
    expect(events.at(-1)).toMatchObject({
      type: 'run.completed',
      data: { outcome: 'succeeded' },
    });
    for (const nodeInstanceId of new Set(
      events.flatMap((event) =>
        'nodeInstanceId' in event.data ? [event.data.nodeInstanceId] : [],
      ),
    )) {
      const lifecycle = events.filter(
        (event) => 'nodeInstanceId' in event.data && event.data.nodeInstanceId === nodeInstanceId,
      );
      expect(lifecycle.map(({ type }) => type)).toStrictEqual([
        'nodeExecution.started',
        'nodeExecution.completed',
      ]);
    }
  });

  it('drains a failed execution and its one terminal failure event', async () => {
    const executor = new ControlledRunExecutor();
    const runManager = await startManager(executor);
    const runId = `failed-events-${randomUUID()}`;

    await runManager.startRun({
      runId,
      executionPlan: executionPlan(
        routeOutcomes(task('work'), {
          completed: end('succeeded'),
          failed: end('failed'),
        }),
        { bindings: [agentBinding('work', 'worker')] },
      ),
      input: null,
    });
    await executor.fail('main/work', 'execution_failed');
    await waitForRunStatus(runManager, runId, 'failed');

    const events = await collectEvents(runManager, runId);
    expectStoredOrder(events, runId);
    expect(events.map(({ type }) => type)).toStrictEqual([
      'nodeExecution.started',
      'nodeExecution.failed',
      'run.failed',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', data: { outcome: 'failed' } });
  });

  it('drains the accepted prefix and terminates when cancellation interrupts publication', async () => {
    const executor = new ControlledRunExecutor();
    const runManager = await startManager(executor);
    const runId = `cancelled-events-${randomUUID()}`;

    await runManager.startRun({
      runId,
      executionPlan: executionPlan(task('work'), {
        bindings: [agentBinding('work', 'worker')],
      }),
      input: null,
    });
    const subscription = runManager.subscribeRunEvents(runId)[Symbol.asyncIterator]();
    const first = await subscription.next();
    expect(first).toMatchObject({
      done: false,
      value: { type: 'nodeExecution.started' },
    });

    await DBOS.cancelWorkflow(runWorkflowId(runId));
    await executor.complete('main/work', { kind: 'completed', outcome: 'completed' });
    await waitForRunStatus(runManager, runId, 'cancelled');
    await expect(runManager.waitForTerminal(runId, { timeoutMs: 1_000 })).resolves.toMatchObject({
      id: runId,
      status: 'cancelled',
    });

    const acceptedPrefix: RunEvent[] = [];
    if (!first.done) {
      acceptedPrefix.push(first.value);
    }
    const drainAcceptedPrefix = async (): Promise<void> => {
      const next = await subscription.next();
      if (next.done) {
        return;
      }
      acceptedPrefix.push(next.value);
      await drainAcceptedPrefix();
    };
    await drainAcceptedPrefix();
    expectStoredOrder(acceptedPrefix, runId);
    expect(acceptedPrefix.map(({ type }) => type)).toStrictEqual(['nodeExecution.started']);
    expect(
      acceptedPrefix.some(({ type }) => type === 'run.completed' || type === 'run.failed'),
    ).toBe(false);
    await expect(runManager.getRunEvents(runId)).resolves.toMatchObject({
      items: [{ type: 'nodeExecution.started' }],
      nextCursor: `${runId}:1`,
      hasMore: false,
    });
  });
});
