#!/usr/bin/env node

import { createRunManager, type PipelineSourcePackage, type RunProfile } from '@revisium/revo-run';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required.');
}

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

const pipeline: PipelineSourcePackage = {
  schemaVersion: 'pipeline-source/v1',
  key: 'quick-start',
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
        entry: 'done',
        outputSchema: emptySchema,
        exits: [{ outcome: 'ok', outputSchema: emptySchema }],
        nodes: [{ kind: 'end', id: 'done', outcome: 'ok', output: {} }],
      },
    },
  ],
};

const profile: RunProfile = {
  schemaVersion: 'run-profile/v1',
  selections: {},
  bindings: { agents: {}, scripts: {} },
};

const manager = createRunManager({
  database: { url: databaseUrl },
  host: {
    resources: { inspect: async () => undefined },
    workspaces: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('The quick start has no workspace.');
      },
    },
    credentials: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('The quick start has no credential.');
      },
    },
  },
});

const runId = `quickStart_${Date.now().toString(36)}`;

await manager.start();
try {
  await manager.createRun({ runId, pipeline, profile, input: {} });
  const terminal = await manager.waitForTerminal(runId, { timeoutMs: 30_000 });
  if (terminal.status !== 'succeeded') {
    throw new Error(`Quick-start run ${runId} ended ${terminal.status}.`);
  }
  console.log(`REVO_RUN_QUICK_START=${runId}`);
} finally {
  await manager.stop();
}
