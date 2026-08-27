import {
  createRunManager,
  type PipelineSourcePackage,
  type RunManager,
} from '../../../src/index.js';

const databaseUrl = process.env.RN1_TEST_DATABASE_URL;
const runId = process.env.RN1_TEST_RUN_ID;
const mode = process.env.RN1_TEST_MODE;

if (databaseUrl === undefined || runId === undefined || (mode !== 'start' && mode !== 'recover')) {
  throw new Error('RN1 signal recovery worker has invalid input.');
}

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const pipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'rn1-signal-recovery',
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
            wait: { kind: 'signal', signal: 'continue', payloadSchema: null },
            routes: { completed: 'done', cancelled: 'done' },
          },
          { kind: 'end', id: 'done', outcome: 'ok', output: {} },
        ],
      },
    },
  ],
};

const manager: RunManager = createRunManager({
  database: { url: databaseUrl },
  host: {
    resources: { inspect: async () => undefined },
    workspaces: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('unused');
      },
    },
    credentials: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('unused');
      },
    },
  },
});

const waitForPending = async (): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- bounded durable observation poll.
    const waitId = (await manager.getRunDetails(runId))?.waits[0]?.waitId;
    if (waitId !== undefined) {
      return waitId;
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded process test delay.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Signal wait was not recovered.');
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
process.send?.({ kind: 'ready', waitId: await waitForPending() });
const handleMessage = async (message: unknown): Promise<void> => {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('kind' in message) ||
    message.kind !== 'signal'
  ) {
    return;
  }
  const waitId = await waitForPending();
  await manager.sendSignal({ runId, waitId, signal: 'continue', actorId: 'test' });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- bounded durable observation poll.
    const snapshot = await manager.getRun(runId);
    if (snapshot?.status === 'succeeded') {
      process.send?.({ kind: 'terminal' });
      // oxlint-disable-next-line no-await-in-loop -- terminal cleanup ends this worker immediately.
      await manager.stop();
      process.exit(0);
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded process test delay.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Recovered run did not reach terminal state.');
};

process.on('message', (message: unknown) => {
  void handleMessage(message);
});
