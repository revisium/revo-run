# Repository Contract

This repository owns the reusable durable multi-run manager for Revo. It is a
library package, not a workflow authoring system, database framework, API
server, provider-specific runtime, queue, or independently deployed service.

## Source of truth

Use this order when sources disagree:

1. Implemented source, tests, and `package.json#exports` describe shipped
   behavior.
2. Accepted ADRs define architecture decisions.
3. Stable specs define implemented contracts.
4. Draft specs define target behavior only.
5. `docs/architecture.md` explains the Accepted dependency direction.
6. `README.md` summarizes consumer-visible status.

The architecture validator is active. RunManager APIs and product layers remain
Draft/unimplemented. The current root export is intentionally empty; the
`@revisium/revo-run/canonical-json` semantic subpath is Stable and implemented.

## Package ownership

The implemented foundation owns bounded descriptor-safe JSON snapshots, RFC
8785 canonical text, and canonical SHA-256 digests. These utilities are not
execution-plan or executor pin types.

The target package owns:

- one reusable `RunManager` serving many durable runs;
- manager start/quiesce/drain/stop, polling, dispatch, heartbeat, retry,
  cancellation, recovery, observation, and terminal waits;
- authoritative `Run`, causally scoped `RunNodeInstance`, and `Attempt`;
- immutable `RunOutput` and ordered append-only `RunEvent`;
- atomic state, attempt, output, event, and scoped activation transitions;
- database-time claim, Start CAS, lease, fence, expiry, and result decisions;
- package-generated manager incarnations;
- exact plan-document and executor-contract resolution;
- pipeline/gate progression through lifecycle;
- pull-based durable subscriptions.

The host owns concrete storage, plan compilation/versioning, executor adapters
and credentials, API/auth, product projections, deployment, process lifecycle,
and observability wiring.

## Exact plan and executor authority

`Run` persists plan id/revision/digest. `ExecutionPlanSource.loadExact()` returns
an immutable package-owned `RunExecutionPlanDocument`. Its `compiledPipeline`
field is bounded `JsonValue`; only private `lifecycle/pipeline/**` decodes it
with the future public pipeline decoder. The public lifecycle index is
pipeline-free.

Ports, manager, composition, root exports, and declarations may not contain
pipeline-owned types or casts to them.

Each executable binding carries `ExecutorContractPin`, configuration digest,
and explicit idempotency declaration. Attempt persists the exact pin/digest.
Recovery uses `resolveExact()` with no latest/default/compatible fallback.

## Dependency direction

```text
spec      policy      errors
  \          |          /
            domain
               |
            storage     ports
                 \       /
                  lifecycle
                      |
                   manager
                      |
                  composition
```

Exact allowed dependencies:

- `spec` -> none;
- `policy` -> `spec`;
- `errors` -> `spec`;
- `domain` -> `spec`, `policy`, `errors`;
- `storage` -> `spec`, `errors`, `domain`;
- `ports` -> `spec`, `errors`;
- `lifecycle` -> `spec`, `policy`, `errors`, `domain`, `storage`, `ports`;
- `manager` -> `spec`, `policy`, `errors`, `ports`, `lifecycle`;
- `composition` -> `spec`, `errors`, `storage`, `ports`, `lifecycle`,
  `manager`.

Lifecycle is the only writable storage/domain path; only its private
`pipeline/**` subtree imports the pipeline package. Manager never imports
storage, domain, pipeline, or private lifecycle leaves: it imports
`lifecycle/index.ts` and consumes explicit contracts without
`Parameters<>`/`ReturnType<>` inference. Composition wires injected store/ports
to lifecycle and manager. Root uses curated composition/public barrels.

`spec`, `errors`, `storage`, and `ports` are type-only. Unknown source layers
fail closed.

## Ownership and time

Every `start()` allocates a unique package-generated `managerIncarnationId`.
Attempt persists it. `ownerLabel` exists only for diagnostics and cannot prove
ownership.

All behavior-affecting time comes from the store transaction. Start, heartbeat,
direct/reconciled/cancellation result, and lease renewal require
`transactionNow < leaseExpiresAt`; equality is expired.

Claim commits phase `claimed`, incarnation, fence, lease, exact executor pin,
and configuration digest. Exact executor resolution and configuration
verification happen next. A separate internal Start CAS then obtains fresh
transaction time and changes the phase to `start_committed`; only then may
`execute()` begin.

Recovery may safely reclaim `claimed` without assuming a side effect. Lost
`start_committed` is unknown. Recovery takeover is allowed only at
database-time lease expiry or through an explicit durable handoff written under
the incumbent incarnation/fence. It then acquires a new incarnation/fence,
resolves the exact executor/configuration, and reconciles; it does not blindly
execute.

## Forks, joins, and gates

Fork-created node instances carry causal fork scope. Join readiness and
activation uniqueness use predecessor instances from the matching scope, so
repeated/nested forks cannot cross-satisfy.

A human gate is a waiting node instance identified by runtime activation id.
Its immutable answer and progression commit atomically. There is no
authoritative `Gate` or `JoinArrival`.

## Manager lifecycle

The lifecycle is `stopped -> starting -> running -> quiescing -> draining ->
stopped`.

Quiescing stops new claims. Heartbeats and fenced result commits continue while
draining. Timeout aborts local work only after an explicit durable handoff
commits under the active incarnation/fence. After `stopped`, no manager timer,
callback, or executor completion may write. A later start uses a new
incarnation.

## Durable observation

`subscribe()` returns a pull `RunSubscription` `AsyncIterable`. Its `.initial`
contains a consistent immutable snapshot plus event high-watermark cursor; it
yields bounded cursor-bearing items/pages strictly after that cursor. Consumers
control backpressure and resume from cursor. A terminal initial snapshot means
the iterator is already complete; after yielding a terminal item it completes
without another read or wait.

`waitForTerminal()` uses the same durable snapshot/cursor protocol.
Notification may optimize wakeup but is not authority.

## Public surface

Public entrypoints exist only in the export map. The foundation exposes an
empty root plus the implemented `./canonical-json` semantic subpath. No Draft
path reserves a future deep import.
