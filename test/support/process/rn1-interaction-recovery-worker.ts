import {
  createRunManager,
  type PipelineSourcePackage,
  type RunManager,
} from '../../../src/index.js';

const databaseUrl = process.env.RN1_TEST_DATABASE_URL;
const runId = process.env.RN1_TEST_RUN_ID;
const mode = process.env.RN1_TEST_MODE;
const operation = process.env.RN1_TEST_INTERACTION;

if (
  databaseUrl === undefined ||
  runId === undefined ||
  (mode !== 'start' && mode !== 'recover') ||
  (operation !== 'duration' && operation !== 'gate' && operation !== 'parallel')
) {
  throw new Error('RN1 interaction recovery worker has invalid input.');
}

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

const end = { kind: 'end' as const, id: 'done', outcome: 'ok', output: {} };

const durationPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-duration-recovery',
  entryModule: 'main',
  maximumTotalActivities: 1,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'pause',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'wait',
            id: 'pause',
            wait: { kind: 'duration', durationMs: 1_000 },
            routes: { completed: 'done', cancelled: 'done' },
          },
          end,
        ],
      },
    },
  ],
};

const gatePipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-gate-recovery',
  entryModule: 'main',
  maximumTotalActivities: 1,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'approve',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'humanGate',
            id: 'approve',
            subject: 'Approve recovery',
            answers: ['approved'],
            authorizationRequirements: ['reviewer'],
            payloadSchema: null,
            deadline: null,
            routes: { answers: [{ answer: 'approved', target: 'done' }], cancelled: 'done' },
          },
          end,
        ],
      },
    },
  ],
};

const parallelPipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-parallel-recovery',
  entryModule: 'main',
  maximumTotalActivities: 2,
  modules: [
    {
      key: 'main',
      inputSchema: emptySchema,
      outputSchema: emptySchema,
      region: {
        key: 'root',
        inputSchema: emptySchema,
        entry: 'parallel',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [
          {
            kind: 'parallel',
            id: 'parallel',
            policy: { kind: 'all' },
            remaining: 'drain',
            routes: {
              completed: 'done',
              impossible: 'done',
              failed: 'done',
              cancelled: 'done',
            },
            branches: [
              {
                key: 'left',
                input: {},
                exits: [{ outcome: 'ok', classification: 'qualifies' }],
                region: {
                  key: 'left-region',
                  inputSchema: emptySchema,
                  entry: 'wait-left',
                  outputSchema: emptySchema,
                  exits: [{ outcome: 'ok', outputSchema: emptySchema }],
                  nodes: [
                    {
                      kind: 'wait',
                      id: 'wait-left',
                      wait: { kind: 'signal', signal: 'left', payloadSchema: null },
                      routes: { completed: 'left-end', cancelled: 'left-end' },
                    },
                    { kind: 'end', id: 'left-end', outcome: 'ok', output: {} },
                  ],
                },
              },
              {
                key: 'right',
                input: {},
                exits: [{ outcome: 'ok', classification: 'qualifies' }],
                region: {
                  key: 'right-region',
                  inputSchema: emptySchema,
                  entry: 'wait-right',
                  outputSchema: emptySchema,
                  exits: [{ outcome: 'ok', outputSchema: emptySchema }],
                  nodes: [
                    {
                      kind: 'wait',
                      id: 'wait-right',
                      wait: { kind: 'signal', signal: 'right', payloadSchema: null },
                      routes: { completed: 'right-end', cancelled: 'right-end' },
                    },
                    { kind: 'end', id: 'right-end', outcome: 'ok', output: {} },
                  ],
                },
              },
            ],
          },
          end,
        ],
      },
    },
  ],
};

const pipeline =
  operation === 'duration'
    ? durationPipeline
    : operation === 'gate'
      ? gatePipeline
      : parallelPipeline;

const manager: RunManager = createRunManager({
  database: { url: databaseUrl },
  host: {
    resources: { inspect: async () => undefined },
    workspaces: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('Interaction fixture never acquires a workspace.');
      },
    },
    credentials: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('Interaction fixture never acquires a credential.');
      },
    },
  },
});

const delay = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 25));

const waitForReady = async (): Promise<
  | Readonly<{ readonly kind: 'duration'; readonly waitIds: readonly string[] }>
  | Readonly<{ readonly kind: 'gate'; readonly gateId: string }>
  | Readonly<{ readonly kind: 'parallel'; readonly waitIds: readonly string[] }>
> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- bounded durable observation poll.
    const details = await manager.getRunDetails(runId);
    if (details === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- wait for root publication.
      await delay();
      continue;
    }
    if (operation === 'gate') {
      const gate = details.gates.find(({ status }) => status === 'pending');
      if (gate !== undefined) {
        return { kind: 'gate', gateId: gate.gateId };
      }
    } else {
      const waits = details.waits.filter(({ status }) => status === 'pending');
      const expected = operation === 'parallel' ? 2 : 1;
      if (waits.length === expected) {
        return { kind: operation, waitIds: waits.map(({ waitId }) => waitId).toSorted() };
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- wait for child operation publication.
    await delay();
  }
  throw new Error('Interaction did not become durably pending.');
};

const waitForTerminal = async (): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- bounded terminal observation poll.
    const snapshot = await manager.getRun(runId);
    if (snapshot?.status === 'succeeded') {
      process.send?.({ kind: 'terminal' });
      // oxlint-disable-next-line no-await-in-loop -- terminal cleanup must complete before worker exit.
      await manager.stop();
      process.exit(0);
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded terminal observation poll.
    await delay();
  }
  throw new Error('Interaction did not settle after recovery.');
};

await manager.start();
if (mode === 'start') {
  await manager.createRun({
    runId,
    pipeline,
    profile: {
      schemaVersion: 'run-profile/v1',
      selections: {},
      bindings: { agents: {}, scripts: {} },
    },
    input: {},
  });
}
const ready = await waitForReady();
const eventTypes = (await manager.getRunEvents(runId)).items.map(({ payload }) => payload.type);
process.send?.(
  ready.kind === 'gate'
    ? { kind: 'ready', interaction: ready.kind, gateId: ready.gateId, eventTypes }
    : { kind: 'ready', interaction: ready.kind, waitIds: ready.waitIds, eventTypes },
);

if (operation === 'duration') {
  await waitForTerminal();
}

process.on('message', (message: unknown) => {
  void (async (): Promise<void> => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('kind' in message) ||
      message.kind !== 'settle'
    ) {
      return;
    }
    if (ready.kind === 'gate') {
      await manager.answerGate({
        runId,
        gateId: ready.gateId,
        answer: 'approved',
        actorId: 'reviewer-1',
        actorGroups: ['reviewer'],
      });
    } else {
      const details = await manager.getRunDetails(runId);
      const waits = details?.waits.filter(({ status }) => status === 'pending') ?? [];
      if (waits.some(({ signal }) => signal === null)) {
        throw new Error('Parallel recovery fixture expected only signal waits.');
      }
      await Promise.all(
        waits.map(async ({ waitId, signal }) => {
          if (signal === null) {
            throw new Error('Parallel recovery fixture expected a signal wait.');
          }
          await manager.sendSignal({ runId, waitId, signal, actorId: 'test' });
        }),
      );
    }
    await waitForTerminal();
  })();
});
