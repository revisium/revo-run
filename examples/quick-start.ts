#!/usr/bin/env node

import { createRunManager } from '@revisium/revo-run';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required.');
}

const manager = createRunManager({
  database: {
    url: databaseUrl,
  },
  executor: {
    async execute() {
      return { kind: 'completed', outcome: 'completed' };
    },
  },
});

const runId = `quickStart_${Date.now().toString(36)}`;

await manager.start();
try {
  await manager.startRun({
    runId,
    executionPlan: {
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
    },
    input: { subject: 'example' },
  });
  const terminal = await manager.waitForTerminal(runId, { timeoutMs: 30_000 });
  if (terminal.status !== 'succeeded') {
    throw new Error(`Packed consumer run ${runId} ended ${terminal.status}.`);
  }
  console.log(`REVO_RUN_QUICK_START=${runId}`);
} finally {
  await manager.stop();
}
