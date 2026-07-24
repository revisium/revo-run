# Architecture

## Status

This architecture is **Accepted** and its module rules are actively enforced by
repository validation. The repository still ships only an empty ESM entrypoint;
all described product APIs are Draft and unimplemented.

## Purpose

`@revisium/revo-run` is a reusable library whose `RunManager` owns the complete
durable lifecycle of many runs. A host injects storage, an exact immutable plan
source, exact executor resolution, identifiers, and process-local policy. The
manager owns recovery, polling, claims, leases, fences, heartbeats, dispatch,
retries, pipeline and gate progression, cancellation, durable observation,
terminal waits, and graceful drain.

The host has no `RunWorker`. It owns application composition, API/auth,
projections, concrete store wiring, immutable plan compilation and persistence,
and executor adapters.

## Durable model

```text
Run
├── RunNodeInstance*
│   ├── Attempt*
│   └── RunOutput*
└── RunEvent*
```

- `Run` owns lifecycle, monotonic aggregate revision, and the exact execution
  plan pin.
- `RunNodeInstance` represents one runtime activation and records its causal
  fork scope.
- `Attempt` is the authoritative execution owner, phase, lease, fence, manager
  incarnation, and exact executor-contract record.
- `RunOutput` is an immutable named and typed value or artifact reference.
- `RunEvent` is an ordered append-only audit and durable observation feed.

Current rows are authoritative mutable state. Events do not replace them and
recovery does not require replay. There is no authoritative `Gate` or
`JoinArrival` entity.

## Public plan document

`ExecutionPlanSource.loadExact(planPin)` returns a package-owned immutable
`RunExecutionPlanDocument`. Its pipeline field is bounded `JsonValue`; it is not
a `CompiledPipeline` or any other pipeline-package type.

Only private `lifecycle/pipeline/**` modules may pass that JSON value to the
future public `@revisium/revo-pipeline` decoder. The public
`lifecycle/index.ts` facade is pipeline-free. Decode failures are stable
plan-integrity faults. Ports, manager, composition, root exports, and emitted
declarations may contain neither pipeline types nor casts that pretend JSON is
already decoded.

Each executable binding in the document contains:

- an exact `ExecutorContractPin`;
- an immutable configuration value and configuration digest;
- the explicit execution-idempotency declaration;
- bounded retry/cancellation policy.

The exact executor pin and configuration digest are persisted with the Attempt.
Recovery calls `ExecutorResolver.resolveExact(pin)` and verifies the
configuration digest. There is no latest, compatible, nearest, or default
fallback.

## Composition

```text
host
  |
  +-- RunStore ---------------- durable transactions and DB time
  +-- ExecutionPlanSource ----- exact JSON plan document by persisted pin
  +-- ExecutorResolver -------- resolveExact plus execute/reconcile/cancel
  +-- IdSource ---------------- durable ids and manager incarnation ids
  +-- LocalClock -------------- local waits/testing only
  `-- coordination policy ----- owner label, polling, heartbeat, concurrency
          |
          v
      composition
          |
          +--> lifecycle (sole writable store/domain/pipeline path)
          `--> manager   (loops and public facade)
```

The composition layer constructs lifecycle with storage and ports, then
constructs manager against lifecycle and safe read/port contracts. Manager
never imports domain or storage directly. It imports lifecycle only through
`lifecycle/index.ts` and consumes explicit facade types; it cannot infer the
boundary from lifecycle implementation functions with `Parameters<>` or
`ReturnType<>`.

`ownerLabel` is diagnostic only. Each successful `start()` allocates a unique,
package-generated `managerIncarnationId`; every claimed Attempt records it.
No configured process label can be durable ownership authority.

## Public and internal surfaces

The Draft public facade contains only:

```text
createRunManager
  start
  stop
  startRun
  answerGate
  cancelRun
  getRun
  listRuns
  subscribe
  waitForTerminal
```

Claim, Start CAS, heartbeat, completion, failure, lease expiry, recovery,
reconciliation, and pipeline progression are internal.

## Claim, start, and execute

```text
lifecycle claim transaction (database time)
  -> create Attempt phase=claimed
  -> persist managerIncarnationId, fence, lease, executor pin/config digest
  -> commit
          |
          v
resolveExact(executor pin) + verify configuration digest
          |
          v
internal Start CAS transaction (fresh database time)
  -> verify active Attempt + incarnation + fence
  -> require now < leaseExpiresAt
  -> phase=start_committed + event
  -> commit
          |
          v
executor.execute()
```

Exact resolution and configuration verification occur before Start so an
unavailable or mismatched adapter cannot create a started Attempt. The Start CAS
then obtains fresh database time because resolution may take time. Resolution
grants no authority; executor dispatch before `start_committed` is forbidden.

Heartbeat, direct result, reconciled result, cancellation result, and Start
MUST reject when transaction time is greater than or equal to lease expiry.
Local time cannot authorize them.

## Recovery

A recovery owner may take over only when a transaction observes
`transactionNow >= leaseExpiresAt`, or when the incumbent previously committed
an explicit durable handoff under its active incarnation and fence. Local clock,
process death detection, missing local heartbeats, and `ownerLabel` never
authorize takeover.

A `claimed` Attempt with no committed start is safe to recover without assuming
an external side effect. After eligible takeover establishes a new incarnation
and fence, recovery resolves the exact executor and verifies its configuration,
then performs a fresh Start CAS using newly obtained transaction time.

A `start_committed` Attempt whose process outcome is lost is conservatively
unknown. After the same expiry-or-handoff takeover gate, recovery acquires a new
incarnation/fence, resolves the persisted exact executor/configuration, and
then calls `reconcile()`. It must not execute again unless reconciliation
establishes a known result or the exact binding declares execution idempotent
and retry policy allows a new Attempt.

Old-incarnation heartbeats and results are stale even when their process still
runs.

The package does not promise physical exactly-once execution.

## Lifecycle and pipeline seam

```text
manager asks lifecycle to advance
    |
    v
lifecycle facade loads the exact JSON plan document
and delegates pipeline work to private lifecycle/pipeline modules
    |
    v
domain validates expected state/fence/gate revision
and computes a prospective change without committing
    |
    v
lifecycle combines fresh scoped sibling state with prospective outcome/answer
and calls the public pipeline decision API
    |
    v
lifecycle maps PipelineDecision to package-owned intents
    |
    v
domain validates combined invariants
    |
    v
store transaction CASes expected revisions/fence and atomically commits
state + attempts + outputs + events + scoped activations
    |
    `-- conflict -> reload and recompute
```

Lifecycle is the sole writable path to domain/storage. Only its private
`pipeline/**` subtree imports the pipeline package; its public index exports
only explicit package-owned facade contracts. Manager orchestrates calls
through that index and cannot mutate the store directly.

Every accepted node transition increments and CASes `Run.revision`. On conflict,
lifecycle reloads scoped siblings and recomputes the prospective change and
pipeline decision.

## Causal fork scope

Every activation created by a fork records a stable causal fork scope derived
from node-instance activation identity, not only a logical node key.

Join readiness considers predecessor node instances in the matching causal
scope. Join activation identity and uniqueness include that scope. This prevents
nodes from repeated/nested fork activations from satisfying one another's join.

There is no `JoinArrival`; readiness is derived from exact plan structure plus
scoped authoritative node instances.

## Gates and cancellation

A human gate is a waiting node instance without an Attempt or lease.
`answerGate()` targets its runtime activation id, stores one immutable answer,
and progresses lifecycle atomically.

Cancellation is durable intent. It stops new claims and permits optional
adapter cancellation. Cancellation results are accepted only before lease
expiry and through the current incarnation/fence.

## Manager state machine

```text
stopped
   |
   v
starting -- recovery and incarnation allocation
   |
   v
running -- claim, Start, execute, heartbeat, progress, observe
   |
   v
quiescing -- no new claims; heartbeats/results/writes continue
   |
   v
draining -- wait for local executions and durable result commits
   |
   +-- drained --------------------------> stopped
   `-- timeout -> abort local work,
                  fenced durable handoff via lifecycle,
                  finish required writes -> stopped
```

Repeated or concurrent lifecycle calls must follow one serialized state
machine. During quiescing/draining, active Attempt heartbeats and fenced result
commits continue. A drain timeout aborts local calls only after performing an
explicit durable handoff under the current incarnation/fence; it does not
silently abandon ownership or report stopped before the handoff commits.

After state becomes `stopped`, manager loops, callbacks, timers, and executor
promises may not initiate store writes. A later `start()` creates a new
incarnation.

## Durable observation

`subscribe()` returns a pull-based `RunSubscription` `AsyncIterable`; it does
not register a push callback. The subscription exposes:

```ts
readonly initial: {
  readonly snapshot: RunSnapshot;
  readonly cursor: RunEventCursor;
};
```

Creation atomically or transactionally consistently obtains:

- `initial.snapshot`, a current immutable run snapshot;
- `initial.cursor`, the event high-watermark for that snapshot.

Iteration then yields bounded pages/items strictly after `initial.cursor`; it
does not replay the initial snapshot as an iterator item. Consumers control
backpressure. Resume is bounded and cursor-based. Notification may wake a
blocked pull but is never state authority.

When `initial.snapshot` is terminal, the iterator is already complete and
performs no poll or wait. When an iterated item is terminal, the iterator
completes immediately after that item without another store read or wait.

`waitForTerminal()` uses the same snapshot/high-watermark/cursor protocol and
cannot maintain a second, weaker observation path.

## Package layers

| Layer         | Responsibility                                              | May depend on                                                |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `spec`        | immutable public values and JSON contracts                  | none                                                         |
| `policy`      | pure retry, limit, and lifecycle policy                     | `spec`                                                       |
| `errors`      | stable typed faults                                         | `spec`                                                       |
| `domain`      | pure aggregate state and prospective decisions              | `spec`, `policy`, `errors`                                   |
| `storage`     | type-only transaction/state/event/eligibility contracts     | `spec`, `errors`, `domain`                                   |
| `ports`       | type-only plan, executor, id, clock, and coordination seams | `spec`, `errors`                                             |
| `lifecycle`   | only writable store/domain path and pipeline seam           | `spec`, `policy`, `errors`, `domain`, `storage`, `ports`     |
| `manager`     | public facade, loops, execution, recovery, observation      | `spec`, `policy`, `errors`, `ports`, `lifecycle`             |
| `composition` | constructs lifecycle and manager from injected contracts    | `spec`, `errors`, `storage`, `ports`, `lifecycle`, `manager` |

Root exports only curated composition/public types. Cross-layer imports use
explicit barrels. Manager imports lifecycle only through `lifecycle/index.ts`
and uses explicit contracts rather than `Parameters<>` or `ReturnType<>`
inference across that boundary. `spec`, `errors`, `storage`, and `ports` are
type-only. Unknown production layers fail closed.

## External boundaries

Only private `lifecycle/pipeline/**` modules may eventually depend on
`@revisium/revo-pipeline`; the package is not installed until implementation
needs its public JSON decoder and decision API. Core excludes Prisma, NestJS,
GraphQL, MCP, DBOS, queues, orchestrator, agent-runtime, and scripts
dependencies.

Packed-package and declaration tests must compile positive and intentionally
leaking transitive declaration graphs, then scan declarations reachable from
the root entry. They must prove the detector sees the negative marker and that
pipeline types/package references and unsafe casts do not leak through plan
source, lifecycle facade, manager, composition, or root declarations.
