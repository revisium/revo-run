# @revisium/revo-run

Alpha DBOS-backed durable pipeline execution for Revo.

```ts
import { createRunManager } from '@revisium/revo-run';
import type { ExecutionPlan, RunExecutor } from '@revisium/revo-run';

const executionPlan: ExecutionPlan = compilation.template;
const executor: RunExecutor = createExecutor();
const manager = createRunManager({ database: { url }, executor });

await manager.start();
const { runId } = await manager.startRun({ runId: requestedRunId, executionPlan, input });
const snapshot = await manager.getRun(runId);
await manager.stop();
```

`ExecutionPlan` is the immutable `PipelineExecutionTemplate` produced by `@revisium/revo-pipeline`. The caller owns plan authoring and storage and passes the exact artifact to each run; `revo-run` has no pipeline or profile store.

DBOS is the continuation and snapshot authority. A successful `startRun` means the workflow and its positional execution-plan/input arguments were durably admitted. `getRun` maps DBOS workflow state into the stable public `RunSnapshot` DTO without a host snapshot store or direct database access.

The host executor owns external effects. Its bounded `reconcile`, `execute`, and `cancel` methods use the supplied deterministic `executionId` as the idempotency key. Every durable effect checkpoint reconciles first and calls `execute` only after an authoritative `not_found`; ambiguous outcomes are never blindly repeated.

A `revo-scripts` host can pack a successful script value into the task completion while keeping script bindings and external reconciliation in its adapter:

```ts
import { createRevoScripts } from '@revisium/revo-scripts';
import type { RunExecutor } from '@revisium/revo-run';

const scripts = createRevoScripts(scriptOptions);
const executor: RunExecutor = {
  async execute(invocation) {
    if (invocation.kind !== 'task' || invocation.script === undefined) {
      return executeNonScript(invocation);
    }
    const result = await scripts.execute({
      bindings: bindingsFor(invocation),
      executionId: invocation.executionId,
      idempotencyKey: invocation.executionId,
      input: invocation.input,
      script: invocation.script,
    });
    return result.ok
      ? {
          status: 'completed',
          completion: { kind: 'task', output: requireJsonValue(result.value) },
        }
      : { status: 'failed', error: { code: 'execution_failed', message: result.error.message } };
  },
  reconcile: reconcileExternalExecution,
  cancel: cancelExternalExecution,
};
```

The concrete executor package owns exact script `id`/`version` lookup and execution. In this example, `revo-scripts` supplies only the `execute` operation; `reconcileExternalExecution` and `cancelExternalExecution` are host-adapter placeholders, not `revo-scripts` capabilities. The host adapter also owns bindings, error mapping, and authoritative reconciliation/cancellation behavior, while `requireJsonValue` represents its script-output validation.

`revo-run` independently validates and detaches returned JSON before the DBOS checkpoint completes. On success, `RunSnapshot.result.outputs` contains the ordered `{ nodeKey, value }` records for tasks that returned output. Outputs are not yet pipeline facts, downstream bindings, or branching inputs. When no task returns output, `RunSnapshot.result` preserves the historical exact `{ outcome }` shape.

The caller supplies each non-empty opaque run ID, which is passed to DBOS unchanged. The package owns DBOS configuration, the `revo-run.run.v2` workflow name, and durable interpretation. The public package has one runtime export, `createRunManager`, and no deep entrypoints.

`startRun` rejects an ID that already belongs to any workflow. If concurrent callers both observe an unused ID, DBOS may converge identical v2 payloads; post-admission validation rejects a foreign workflow or different execution plan/input.
