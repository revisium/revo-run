# @revisium/revo-run

Durable host for Revo pipelines. A consumer supplies a raw pipeline, its selected
profile, and JSON input once; this library validates admission, compiles the
pipeline, hosts its kernel commands, and keeps run observation in DBOS/PostgreSQL.

`@revisium/revo-run` is an alpha package. Its only public entrypoint is the
package root.

For the dependency graph, durable-recovery boundary, and public/private split,
read [the RN1 architecture](docs/architecture.md) and
[ADR 0001](docs/adr/0001-direct-kernel-host.md).

## Ownership boundary

- `@revisium/revo-pipeline` owns the pipeline language, compilation, state machine,
  commands, and transitions.
- `@revisium/revo-scripts` owns script definitions, providers, resource and
  credential acquisition, and one physical script attempt.
- `@revisium/revo-run` owns durable admission, stable operation identities, DBOS
  workflow lifecycle, interactions, recovery observation, and public run views.

The manager does not accept an executor map, compiler callback, lowered plan, or
runner supplied by the consumer. Agent-bearing pipelines are currently rejected
before DBOS admission with `agent_runtime_unavailable`; the future agent-runtime
adapter is intentionally not part of this API.

## Create a manager and run

```ts
import { createRunManager, type PipelineSourcePackage, type RunProfile } from '@revisium/revo-run';

const manager = createRunManager({
  database: { url: process.env.DATABASE_URL! },
  host: {
    resources: coreResourceCatalog,
    workspaces: coreWorkspaceService,
    credentials: coreCredentialVault,
  },
});

await manager.start();

const pipeline: PipelineSourcePackage = storedPipeline.source;
const profile: RunProfile = storedLaunchProfile.profile;

await manager.createRun({
  runId: 'run_01K4Q7T9R2M8',
  pipeline,
  profile,
  input: { pullRequestId: 'pr-42' },
});
```

`createRun()` returns after durable admission and workflow start, not after the
pipeline is terminal. `runId` is consumer-owned and must match
`[A-Za-z][A-Za-z0-9._-]{0,127}`. It is the only creation identity: a second
creation with the same ID returns `run_id_conflict`.

The admitted snapshot fixes the raw source/profile/input, compiled program, and
prepared script bindings. It never contains a secret, acquired credential handle,
absolute workspace path, or live process handle. Recovery uses that snapshot and
does not compile the pipeline again.

## Observe and interact

```ts
const snapshot = await manager.getRun('run_01K4Q7T9R2M8');
const details = await manager.getRunDetails('run_01K4Q7T9R2M8');
const events = await manager.getRunEvents('run_01K4Q7T9R2M8');

if (details?.waits[0]?.kind === 'signal') {
  await manager.sendSignal({
    runId: details.runId,
    waitId: details.waits[0].waitId,
    signal: details.waits[0].signal!,
    actorId: 'operator-1',
  });
}

await manager.cancelRun({ runId: 'run_01K4Q7T9R2M8', actorId: 'operator-1' });
```

The root manager surface is `start`, `stop`, `createRun`, `getRun`, `listRuns`,
`getRunDetails`, `getRunEvents`, `subscribeRunEvents`, `waitForTerminal`,
`cancelRun`, `sendSignal`, and `answerGate`. Runtime schemas for public JSON
values are exported from the root alongside the derived TypeScript types.

Cancellation is a kernel event, not a manager-side terminal guess. It remains
non-terminal until the pipeline returns its terminal cancellation command. A
script outcome that cannot yet be proven becomes `recovery_required`; it has no
replacement attempt or terminal event. Read its exact pending attempt from
`getRunDetails`; `waitForTerminal` and `cancelRun` then return
`run_recovery_required`.

Call `stop()` when the process ends. DBOS configuration and lifecycle are
process-global, so create one manager per process.

## Local verification

```bash
corepack pnpm db:test:up
corepack pnpm verify
corepack pnpm db:test:down
```

The database is a disposable local PostgreSQL instance configured by `.env.test`.
The pipeline and script packages are exact registry dependencies. The complete
gate includes a packed root consumer and rejects local, workspace, Git, URL, and
tarball dependency references.
