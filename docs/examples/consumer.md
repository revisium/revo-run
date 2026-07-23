# Consumer example

> [!IMPORTANT]
> Every name and type shape in this document is **Draft and unimplemented**. The shipped package root is intentionally
> empty. This example illustrates the target host integration; it is not runnable code.

The host owns execution-plan compilation, durable plan storage, worker polling, and physical execution. `revo-run` owns one
concurrency-safe state transition at a time.

## Create the facade

The proposed facade receives only package-owned ports and deterministic utilities. It does not receive a Prisma client,
queue, executor, or worker callback.

```ts
import { createRunEngine } from '@revisium/revo-run';

const runs = createRunEngine({
  store: runStore,
  clock,
  ids,
});
```

`runStore` is a future implementation of the transactional command/query contracts. The core API and domain remain
independent of Prisma and DBOS.

## Supply immutable execution input

The host compiles, stores, loads, and verifies an immutable `ExecutionPlan`. It supplies the matching plan and public
`CompiledPipeline` with every lifecycle mutation.

```ts
const hostPlan = await executionPlanRepository.getExact({
  id: request.executionPlan.id,
  revision: request.executionPlan.revision,
});

await verifyExecutionPlan(hostPlan);

const execution = {
  plan: {
    id: hostPlan.id,
    revision: hostPlan.revision,
    digest: hostPlan.digest,
    transitionPolicy: hostPlan.transitionPolicy,
  },
  pipeline: hostPlan.compiledPipeline,
};
```

`hostPlan` remains in the host and may include executor bindings, prompts, profiles, models, permissions, credentials, and
workspaces. `execution` is the narrower package input: immutable plan pins, bounded transition policy, and the public
compiled pipeline needed for run decisions. The full host plan is never passed into `revo-run` or persisted inside `Run`.

## Create a run

```ts
const created = await runs.createRun({
  execution,
  runId: crypto.randomUUID(),
  idempotencyKey: request.id,
  input: request.input,
});
```

The target transaction creates the `Run`, stores exact plan pins, inserts deterministic initial node instances, and appends
the corresponding audit events. Replaying the same idempotency key returns the same logical result; conflicting input
fails.

## Poll and claim work

The host owns this loop. A candidate query is deliberately separate from the authoritative claim.

```ts
while (!shutdownSignal.aborted) {
  const candidates = await runs.listClaimable({
    now: clock.now(),
    limit: 20,
  });

  for (const candidate of candidates) {
    const hostPlan = await loadHostPlan(candidate.executionPlanPin);
    const execution = toRunExecutionInput(hostPlan);

    try {
      const claim = await runs.claimAttempt({
        execution,
        runId: candidate.runId,
        nodeInstanceId: candidate.nodeInstanceId,
        expected: candidate.expected,
        workerId,
        leaseUntil: clock.now().add({ minutes: 5 }),
        idempotencyKey: `${workerId}:${candidate.nodeInstanceId}:${candidate.nextAttemptNumber}`,
      });

      void executeClaim(hostPlan, execution, claim);
    } catch (error) {
      if (!isRunConflict(error)) {
        throw error;
      }

      // Another worker changed the aggregate. Poll fresh candidates.
    }
  }

  await hostScheduler.waitForNextPoll(shutdownSignal);
}
```

`listClaimable()` never reserves work. `claimAttempt()` atomically:

1. verifies execution-plan pins;
2. CASes expected `Run.revision` and node revision/status;
3. creates the next authoritative `Attempt` with owner, lease, and fencing token;
4. sets `RunNodeInstance.activeAttemptId`;
5. appends the audit event.

The active `Attempt` is the sole live claim authority. A copied worker, lease, or fence field on a node cannot authorize
heartbeat, completion, retry, expiry, or recovery.

## Complete an attempt

```ts
async function executeClaim(
  hostPlan: HostExecutionPlan,
  execution: RunExecutionInput,
  claim: AttemptClaim,
): Promise<void> {
  const started = await runs.startAttempt({
    execution,
    runId: claim.runId,
    nodeInstanceId: claim.nodeInstanceId,
    attemptId: claim.attemptId,
    expected: claim.expected,
    workerId,
    fencingToken: claim.fencingToken,
    idempotencyKey: `${claim.attemptId}:start`,
  });

  let result: HostExecutionResult;

  try {
    result = await hostExecutors.execute({
      binding: hostPlan.executorBindings[claim.nodeKey],
      profile: hostPlan.profiles[claim.nodeKey],
      prompt: hostPlan.prompts[claim.nodeKey],
      workspace: hostPlan.workspaces[claim.nodeKey],
      input: claim.input,
      signal: shutdownSignal,
    });
  } catch (error) {
    await reportFailure(execution, claim, started.expected, error);
    return;
  }

  await runs.completeAttempt({
    execution,
    runId: claim.runId,
    nodeInstanceId: claim.nodeInstanceId,
    attemptId: claim.attemptId,
    expected: started.expected,
    workerId,
    fencingToken: claim.fencingToken,
    outputs: [
      {
        name: 'result',
        type: 'application/json',
        value: result.value,
      },
      ...result.artifacts.map((artifact) => ({
        name: artifact.name,
        type: 'artifact/reference',
        value: artifact.reference,
      })),
    ],
    idempotencyKey: `${claim.attemptId}:complete`,
  });
}
```

Only a physical executor failure is normalized and reported through `failAttempt()`. A completion CAS, stale fence,
duplicate output, storage, or pipeline-decision conflict propagates to host lifecycle handling and is never converted into
an execution failure or retry.

Internally, completion follows one decision path:

```text
validate expected Run/node/Attempt revisions, active Attempt, lease, and fence
-> compute a package-owned prospective success plus immutable outputs
-> combine fresh authoritative siblings plus prospective success into PipelineFacts
-> call the public revo-pipeline decision API
-> map PipelineDecision to package-owned successor/join/wait intents
-> validate the combined domain intent
-> CAS and atomically commit state, outputs, RunEvents, and activations
```

If the aggregate CAS conflicts, the lifecycle discards the prospective change and pipeline decision, reloads fresh state,
and recomputes. It never applies a stale join decision. Every accepted node transition increments `Run.revision`, so one of
two concurrent final branch completions observes the other and activates a ready join. Unique `(runId, activationKey)`
prevents duplicate activation; there is no `JoinArrival` record.

## Fail and retry

```ts
async function reportFailure(
  execution: RunExecutionInput,
  claim: AttemptClaim,
  expected: ExpectedAttemptState,
  error: unknown,
): Promise<void> {
  const transition = await runs.failAttempt({
    execution,
    runId: claim.runId,
    nodeInstanceId: claim.nodeInstanceId,
    attemptId: claim.attemptId,
    expected,
    workerId,
    fencingToken: claim.fencingToken,
    failure: normalizeExecutionFailure(error),
    idempotencyKey: `${claim.attemptId}:fail`,
  });

  if (transition.node.status === 'retry_scheduled') {
    hostMetrics.recordRetryScheduled({
      runId: claim.runId,
      nodeInstanceId: claim.nodeInstanceId,
      availableAt: transition.node.availableAt,
    });
  }
}
```

The immutable execution plan owns retry limits and policy. `revo-run` computes eligibility and atomically writes either
`retry_scheduled` with bounded `availableAt` or terminal failure. The host does not enqueue a separate authoritative retry
record: once due, the node becomes discoverable through the claimable/due-retry query and is claimed as a new `Attempt`.

Lease recovery uses the same authority:

```ts
const expired = await runs.listExpiredLeases({
  now: clock.now(),
  limit: 20,
});

for (const candidate of expired) {
  const hostPlan = await loadHostPlan(candidate.executionPlanPin);
  const execution = toRunExecutionInput(hostPlan);

  await runs.expireAttemptLease({
    execution,
    runId: candidate.runId,
    nodeInstanceId: candidate.nodeInstanceId,
    attemptId: candidate.attemptId,
    expected: candidate.expected,
    fencingToken: candidate.fencingToken,
    idempotencyKey: `${candidate.attemptId}:expire`,
  });
}
```

Once expiry commits, the old fence cannot complete or append successful outputs.

## Answer a human gate

A human gate is a waiting `RunNodeInstance`. It has no `Attempt`, worker, lease, or fencing token. Its accepted answer is an
immutable `RunOutput`.

```ts
const waitingGate = await runs.getWaitingHumanGate({
  runId,
  nodeInstanceId,
});

if (!waitingGate) {
  throw new Error('Human gate is not waiting');
}

const hostPlan = await loadHostPlan(waitingGate.executionPlanPin);
const execution = toRunExecutionInput(hostPlan);

await runs.answerHumanGate({
  execution,
  runId,
  nodeInstanceId,
  expected: {
    runRevision: waitingGate.runRevision,
    nodeRevision: waitingGate.nodeRevision,
    status: 'waiting',
  },
  resolution: 'approved',
  answer: {
    name: 'human-answer',
    type: 'application/json',
    value: {
      comment: 'Proceed with publication.',
    },
  },
  actor: {
    type: 'user',
    id: currentUser.id,
  },
  idempotencyKey: request.id,
});
```

One transaction CASes the run and gate revisions, completes the gate, stores the answer output, appends audit events, and
activates successors. `resolution` is the normalized control-flow fact passed to the pipeline decision; lifecycle never
parses arbitrary `answer.value` JSON to decide a transition. A competing later answer conflicts and appends nothing. There
is no separate authoritative `Gate` entity.

## Read state and project events

Mutable `Run`, `RunNodeInstance`, and `Attempt` rows are current-state authority. A node may emit multiple immutable
`RunOutput` values, including typed payloads and artifact references.

`RunEvent` is an ordered append-only audit record. It supports timelines and rebuildable projections, but recovery does not
replay events to reconstruct current state.

```ts
const snapshot = await runs.getRun({ runId });

const outputs = await runs.listRunOutputs({
  runId,
  nodeInstanceId,
});

const timeline = await runs.listRunEvents({
  runId,
  afterSequence: cursor,
  limit: 100,
});

await outputProjection.apply(outputs);
await timelineProjection.apply(timeline.items);
```

Product inboxes, counters, dashboards, and public API views belong to the host and may be rebuilt from authoritative state
and events.

## Ownership summary

```text
host
  compile/store/verify ExecutionPlan
  poll candidates
  select and run executors
  call lifecycle commands
  project product views

revo-run
  verify exact plan pins
  validate domain preconditions
  derive PipelineFacts and request a pipeline decision
  validate the combined intent
  atomically CAS state + outputs + events + activations

storage adapter
  implement the package-owned transactional ports
```

The core contract has no Prisma, DBOS, queue, worker loop, GraphQL, MCP, CLI, agent-runtime, or script-runtime dependency.
