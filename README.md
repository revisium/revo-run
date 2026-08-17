# @revisium/revo-run

Durable run orchestration for Revo.

## Current scope

The package interprets an admitted `ExecutionPlan` as DBOS workflows. Supported node kinds:

`sequence`, `outcomeSwitch`, `branch`, `parallel`, `subpipeline`, `task`, `end`,
`delay`, `repeat`, `map`, `humanGate`, `consensus`.

Parallel, map, and consensus accept `remaining: 'drain' | 'cancel'`. Cancel joins are
implemented: leftover children are cancelled after the join or verdict is checkpointed.

Task effects run as DBOS steps. DBOS persists workflow input, results, events,
child-workflow progress, terminal result, status, and timestamps in PostgreSQL.

`startRun` is create-only: an already claimed ID returns `run_id_conflict`, even when
the new input is identical. Run IDs must match `[A-Za-z][A-Za-z0-9._-]{0,127}`. If
admission returns `run_admission_failed`, use `getRun(runId)` to see whether the
workflow was committed.

DBOS configuration and lifecycle are process-global. `createRunManager` owns
`DBOS.setConfig` (application name `revo-run`), `DBOS.launch`, and `DBOS.shutdown`.
Create one `RunManager` per process and share it. `stop()` shuts down that process
DBOS runtime.

Human-gate `decision.onConflict: 'wait'` is reserved and rejected at admission
(`unsupported_gate_conflict_policy`). Only `'conflict'` is executable.

## Public API

`src/index.ts` is the only entrypoint. The manager surface is:

- lifecycle: `start`, `stop`
- start: `startRun`
- observe: `getRun`, `listRuns`, `getRunDetails`, `getRunEvents`, `subscribeRunEvents`,
  `waitForTerminal`
- control: `cancelRun`, `answerGate`, `resolveUnknownOutcome`

`RunDetails` members that are durable step payloads (`parallelJoins`,
`skippedParallelBranches`, `mapExecutions`, `skippedMapItems`) ship TypeBox schemas.
Date-bearing projections (`scopes`, `nodeInstances`, `attempts`, `commands`, `gates`,
`consensuses`) are in-memory views and have no runtime schema.

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
await manager.waitForTerminal(runId);
await manager.stop();
```

A parked `humanGate` is resolved with `answerGate`, then observed with
`waitForTerminal`:

```ts
const receipt = await manager.answerGate({
  runId,
  actorId: 'reviewer',
  gateInstanceId: pendingGate.id,
  answer: 'approved',
  commandId: 'cmd_gate_1',
});
const terminal = await manager.waitForTerminal(runId);
```

Use `cancelRun` to cancel an active run and `resolveUnknownOutcome` when a task
attempt is parked as `outcomeUnknown`.
