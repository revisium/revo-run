# Architecture

## Status

This architecture is **Accepted** and its module rules are actively enforced by
repository validation. The package root remains runtime-empty while exporting
Stable portable contract types. The semantic
`@revisium/revo-run/canonical-json` subpath, package-private pure domain
foundation, and package-private type-only Store contracts are implemented.
Store behavior has a logical conformance fake only; no durable adapter or
database concurrency proof exists. Package-private executor snapshots, pure
binding verification, fault refinements, and type-only executor ports are also
implemented. Package-private lifecycle discovery, claim, lease renewal,
durable handoff, ownership acquisition, and exact resolver/Start preparation
are implemented over the Store contract. Lifecycle-owned hostile observation
normalization, reconciliation preparation, and fenced direct-unknown plus
reconciled-running/unknown commits are also implemented. Known terminal
observations are prepared but are not committed without pipeline progression.
Package-private exact plan-source, purpose-specific manager identifier, local
clock/scheduler, and read-only owned-authority hydration contracts are also
implemented. The private decode/reduce progression contract is Accepted by
[ADR 0003](adr/0003-private-pipeline-progression.md), but its domain/Store
foundation is implemented without a pipeline dependency. The dependency,
adapter and lifecycle behavior are not implemented.
Retry selection, cancellation invocation, terminal graph progression,
manager/composition, and all RunManager behavioral APIs remain Draft and
unimplemented.

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

The implemented canonical JSON foundation provides a bounded, descriptor-safe
`JsonValue` snapshot, RFC 8785 text, and SHA-256 digest. It lives in `spec` and
`policy`; it does not decode pipeline data or define a plan pin. The
canonicalizer dependency and `node:crypto` are each isolated to one exact
policy leaf and enforced by architecture and Oxc probes.

The package-private `ExecutionPlanSource.loadExact(planPin)` returns a
package-owned immutable `RunExecutionPlanDocument`. The port does not enter
public manager options or root declarations. Its pipeline field is bounded
`JsonValue`; it is not a `CompiledPipeline` or any other pipeline-package type.

Only private `lifecycle/pipeline/**` modules may pass that JSON value to the
public `@revisium/revo-pipeline` decoder. The public
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
  +-- exact plan loader ------- host capability; adapted to private source
  +-- ExecutorResolver -------- resolveExact plus execute/reconcile/cancel
  +-- ManagerIdSource --------- purpose-specific durable, handoff, and incarnation ids
  +-- LocalClock -------------- local waits/testing only
  +-- LocalScheduler ---------- local enqueue and abortable waits only
  `-- coordination policy ----- owner label, polling, heartbeat, concurrency
          |
          v
      composition
          |
          +--> lifecycle (sole writable store/domain/pipeline path)
          `--> manager   (loops and public facade)
```

The future public shape by which the host supplies exact plan loading is
deliberately deferred. Package-private composition adapts that capability to
`ExecutionPlanSource`, constructs lifecycle with storage and ports, then
constructs manager against lifecycle and safe read/port contracts. Manager
never imports domain or storage directly. It imports lifecycle only through
`lifecycle/index.ts` and consumes explicit facade types; it cannot infer the
boundary from lifecycle implementation functions with `Parameters<>` or
`ReturnType<>`.

`ownerLabel` is diagnostic only. Each successful `start()` allocates a unique,
package-generated `managerIncarnationId`; every claimed Attempt records it.
No configured process label can be durable ownership authority.

Before acting on remembered ownership, manager hydrates it through lifecycle.
Hydration opens a fresh Store transaction and reads the exact Run, node, and
active Attempt. It accepts only the requested incumbent manager incarnation,
fence, active phase, compatible nonterminal Run/node state, no handoff, and
transaction time strictly before lease expiry. The result is a newly copied
full authority plus `start` for `claimed` or `reconcile` for
`start_committed`/`unknown`/`reconciling`. It contains no capability and performs
no write, renewal, takeover, executor resolution, or idempotency operation.

Node-bearing discovery observations include the runtime `nodeInstanceId` and
the bounded logical `nodeKey`. This lets manager select the exact plan binding
and reserve process-local per-adapter capacity before claim. The key remains
contextual to the observed Run's exact plan pin and is re-correlated with
authoritative node state before claim or acquisition replay; it is not durable
authority and does not change v1 semantic idempotency records.

Handoff history uses closed reasons. `manager_shutdown` covers ordinary drain
or stop, while `manager_start_failure` remains reserved for a real manager
starting-cycle failure. `manager_progression_unavailable` preserves authority
that cannot yet cross the real pipeline bridge, and `manager_recovery_failure`
preserves authority when supervisor recovery cannot continue safely.

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
package-owned exact plan document + command
  -> lifecycle opens one Store transaction attempt
  -> loads complete authoritative Run aggregate
  -> private lifecycle/pipeline decodes compiled JSON once
  -> projects package-owned progression snapshot and command
  -> calls reducePipeline once
  -> exhaustively maps the complete ordered effect batch
  -> domain validates one package-owned transition
  -> Store CASes complete revision/absence expectations and commits atomically
  `-> approved conflict: total rollback + package-owned retryable result
```

Lifecycle is the sole writable path to domain/storage. Only its private
`pipeline/**` subtree imports the pipeline package; its public index exports
only explicit package-owned facade contracts. Manager orchestrates calls
through that index and cannot mutate the store directly.

The compiled plan remains bounded `JsonValue` outside the private subtree.
Private code never compiles, repairs, replaces or correctness-caches it. Run
progression is a typed versioned package-owned logical state, not a pipeline
snapshot or inference from generic rows.

Lifecycle never retries internally. The separately implemented RunManager
coordinator will bound retries to four total attempts and must reload the exact
plan and complete authority, obtain fresh transaction time and recompute every
projection, reduction, ID and expectation after each retryable conflict.

Human-gate control data is explicit: normalized resolution and scalar facts are
separate from the arbitrary immutable answer output and commit in the same
transition. Logical terminal closure may retain a `retiring` node with a live or
unknown Attempt fenced by `progressionClosedAt`; later physical settlement
cannot reopen the Run or emit a post-terminal public event.

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

The construction facade is checked as a declaration closure. Every reachable
exported function, variable, and public class member has an explicit
declaration-relevant type, so runtime bodies and value inference cannot widen
the facade. Its only port symbol is `ExecutorResolver`; its sole storage edge is
the exact `RunStore` symbol in `run-lifecycle-dependencies.ts`, including
aliased, namespace, import-equals, inline import-type, and re-export syntax.
That closure has a finite public grammar: named explicitly typed functions,
data-only interfaces with identifier properties, explicit type aliases without
`typeof`, and named explicitly typed `const` values. Default exports,
destructured parameters or bindings, classes, enums, namespaces, computed
members, and interface call/construct/method/index/accessor signatures are
rejected. Typed identifier rest parameters remain explicit and are allowed.
Runtime bodies and typed value initializers are not traversed.
The same grammar applies recursively to local declarations referenced by those
public signatures, with cycle-safe traversal; unrelated private declarations
remain outside the construction closure.

## External boundaries

Only private `lifecycle/pipeline/**` modules may depend on
`@revisium/revo-pipeline`; the package is not installed until implementation
needs its public JSON decoder and reducer API. Its final source is exact npm
registry `0.0.0` after a separate publication/provenance gate; local, workspace,
file and git substitutes are forbidden in committed evidence. Core excludes Prisma, NestJS,
GraphQL, MCP, DBOS, queues, orchestrator, agent-runtime, and scripts
dependencies.

Packed-package and declaration tests must compile positive and intentionally
leaking transitive declaration graphs, then scan declarations reachable from
the root entry. They must prove the detector sees the negative marker and that
pipeline types/package references and unsafe casts do not leak through plan
source, lifecycle facade, manager, composition, or root declarations.
