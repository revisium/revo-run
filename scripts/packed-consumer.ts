#!/usr/bin/env node

import { createRunManager } from '@revisium/revo-run';
import type {
  ExecutionPlan,
  ListRunsInput,
  RunEvent,
  RunEventCursor,
  RunManager,
} from '@revisium/revo-run';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required.');
}

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const collectSubscription = async (
  manager: RunManager,
  runId: string,
  after?: RunEventCursor,
): Promise<readonly RunEvent[]> => {
  const events: RunEvent[] = [];
  const input = after === undefined ? {} : { after };
  for await (const event of manager.subscribeRunEvents(runId, input)) {
    events.push(event);
  }
  return events;
};

const listSucceededIds = async (
  manager: RunManager,
  createdFrom: Date,
  createdThrough: Date,
  offset?: number,
): Promise<readonly string[]> => {
  const input: ListRunsInput = {
    statuses: ['succeeded'],
    createdFrom,
    createdThrough,
    limit: 50,
    ...(offset === undefined ? {} : { offset }),
  };
  const page = await manager.listRuns(input);
  const ids = page.items.map((item) => item.id);
  if (page.nextOffset === undefined) {
    return ids;
  }
  return [
    ...ids,
    ...(await listSucceededIds(manager, createdFrom, createdThrough, page.nextOffset)),
  ];
};

const executionPlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'sequence',
        children: [
          { kind: 'task', key: 'work' },
          { kind: 'end', status: 'succeeded', outcome: 'completed' },
        ],
      },
    },
  },
  bindings: [
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'work' },
      script: { id: 'example.run', revision: 1 },
    },
  ],
  policies: {
    defaultTaskTimeoutMs: 30_000,
    maximumActiveNodeExecutions: 10,
    maximumNodeNestingDepth: 10,
    maximumSubpipelineDepth: 10,
    maximumTotalNodeExecutions: 1_000,
  },
};

const manager = createRunManager({
  database: { url: databaseUrl },
  executor: {
    async execute() {
      return { kind: 'completed', outcome: 'completed' };
    },
  },
});

const stamp = Date.now().toString(36);
const primaryRunId = `smokeApi_${stamp}`;
const secondaryRunId = `smokeApiB_${stamp}`;
const createdFrom = new Date(Date.now() - 1_000);

await manager.start();
try {
  await manager.startRun({
    runId: primaryRunId,
    executionPlan,
    input: { subject: 'primary' },
  });

  const liveEventsPromise = collectSubscription(manager, primaryRunId);
  const started = await manager.getRun(primaryRunId);
  assert(started !== undefined, `getRun missed ${primaryRunId}.`);
  assert(started.id === primaryRunId, 'getRun returned a different run.');

  const terminal = await manager.waitForTerminal(primaryRunId, { timeoutMs: 30_000 });
  assert(terminal.status === 'succeeded', `primary run ${primaryRunId} ended ${terminal.status}.`);
  assert(terminal.result.outcome === 'completed', 'primary run outcome was not completed.');

  const liveEvents = await liveEventsPromise;
  assert(liveEvents.length >= 3, `live subscribe returned ${String(liveEvents.length)} events.`);
  assert(
    liveEvents[0]?.type === 'nodeExecution.started',
    'live stream did not start with the task.',
  );
  assert(
    liveEvents.at(-1)?.type === 'run.completed',
    'live stream did not end with run.completed.',
  );

  await manager.startRun({
    runId: secondaryRunId,
    executionPlan,
    input: { subject: 'secondary' },
  });
  const secondary = await manager.waitForTerminal(secondaryRunId, { timeoutMs: 30_000 });
  assert(
    secondary.status === 'succeeded',
    `secondary run ${secondaryRunId} ended ${secondary.status}.`,
  );

  const createdThrough = new Date(Date.now() + 1_000);
  const listedIds = await listSucceededIds(manager, createdFrom, createdThrough);
  assert(listedIds.includes(primaryRunId), 'listRuns missed the primary succeeded run.');
  assert(listedIds.includes(secondaryRunId), 'listRuns missed the secondary succeeded run.');

  const details = await manager.getRunDetails(primaryRunId);
  assert(details !== undefined, `getRunDetails missed ${primaryRunId}.`);
  assert(details.run.status === 'succeeded', 'getRunDetails status was not succeeded.');

  const allEvents = await manager.getRunEvents(primaryRunId);
  assert(
    allEvents.items.length === liveEvents.length,
    'getRunEvents count did not match subscribe.',
  );
  const firstEventPage = await manager.getRunEvents(primaryRunId, { limit: 1 });
  assert(firstEventPage.nextCursor !== undefined, 'getRunEvents omitted the continuation cursor.');
  const afterFirst = await collectSubscription(manager, primaryRunId, firstEventPage.nextCursor);
  assert(afterFirst.length === allEvents.items.length - 1, 'subscribe after cursor dropped items.');

  console.log(`REVO_RUN_PACKED_CONSUMER=${primaryRunId}`);
} finally {
  await manager.stop();
}
