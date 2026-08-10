# @revisium/revo-run

Durable run orchestration for Revo.

## Current scope

The current alpha executes deterministic `sequence`, `outcomeSwitch`, `branch`, `parallel`,
`subpipeline`, `task`, and `end` nodes. Parallel nodes support `all`, `any`, and `threshold`
joins with `remaining: 'drain'`; cancel joins are not implemented yet. Parallel branches are DBOS
child workflows, and plan-wide active and total execution limits apply across nested branches.

Task effects run as DBOS steps. DBOS persists workflow input, task results, events, child-workflow
progress, terminal result, status, and timestamps in PostgreSQL.

The public runtime API contains `createRunManager`, lifecycle methods, `startRun`, `getRun`,
`getRunDetails`, and `subscribeRunEvents`.

`startRun` is create-only: an already claimed ID returns `run_id_conflict`, even when the new
input is identical. Run IDs must match `[A-Za-z][A-Za-z0-9._-]{0,127}`. If admission returns
`run_admission_failed`, use `getRun(runId)` to resolve whether the workflow was committed.

DBOS has one process-global runtime. Create one `RunManager` per process and share it across
consumers.

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
  executor: {
    async execute(request, { signal }) {
      // Resolve entity, artifact, and secret references inside this boundary.
      // Dispatch request.binding to an agent or script adapter and pass signal
      // to the underlying operation so DBOS step timeouts can cancel it.
      return { kind: 'completed', outcome: 'completed' };
    },
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
const details = await manager.getRunDetails(runId);
await manager.stop();
```
