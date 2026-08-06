# @revisium/revo-run

Durable run orchestration for Revo.

## Current scope

The current alpha executes an execution plan whose root is an `end` node without output mappings.
DBOS persists the workflow input, status, result, and timestamps in PostgreSQL.

The public runtime API contains `createRunManager`, `start`, `stop`, `startRun`, and `getRun`.

## Example

```ts
import { createRunManager } from '@revisium/revo-run';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required.');
}

const manager = createRunManager({
  database: {
    url: databaseUrl,
  },
});

await manager.start();

const { runId } = await manager.startRun({
  runId: 'run_01',
  executionPlan: {
    schemaVersion: 1,
    rootPipelineId: 'main',
    pipelines: {
      main: {
        root: {
          kind: 'end',
          status: 'succeeded',
          outcome: 'completed',
        },
      },
    },
    bindings: [],
    policies: {
      defaultTaskTimeoutMs: 3_600_000,
      maximumActiveNodeExecutions: 10,
      maximumNodeNestingDepth: 10,
      maximumSubpipelineDepth: 10,
      maximumTotalNodeExecutions: 1_000,
    },
  },
  input: { subject: 'example' },
});

const run = await manager.getRun(runId);
await manager.stop();
```
