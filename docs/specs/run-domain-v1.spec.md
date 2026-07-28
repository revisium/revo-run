# Run domain v1

- Status: Draft
- Implementation: Package-private pure domain foundation implemented;
  progression-state extension Accepted by ADR 0003 but unimplemented;
  persistence, lifecycle graph progression, and public snapshots not implemented

## Normative language and versioning

BCP 14 keywords are interpreted per RFC 2119/RFC 8174 only when uppercase.
`v1` identifies this contract family; incompatible post-Stable changes require a
new `vN`, while this Draft may still change.

## Scope

This specification defines the durable run aggregate and its invariants. It
does not define manager loops, storage technology, executor providers, or
pipeline-owned graph types.

## Aggregate

```text
Run
├── RunNodeInstance*
│   ├── Attempt*
│   └── RunOutput*
└── RunEvent*
```

### Run

A `Run` MUST contain:

- package-owned run id;
- exact immutable execution-plan pin (`id`, `revision`, `digest`);
- lifecycle status;
- monotonic aggregate revision;
- bounded immutable input and optional metadata;
- creation/update/terminal timestamps assigned from store transaction time.

The plan pin MUST never change after creation.

Implemented status is exactly `running`, `cancelling`, `succeeded`, `failed`,
or `cancelled`. `running` may transition to any other status; `cancelling` may
transition to a terminal status; terminal status cannot transition.

### RunNodeInstance

A node instance represents one runtime activation of one logical plan node. It
MUST contain:

- package-owned node-instance id;
- stable runtime activation id and deterministic activation key;
- causal fork scope derived from node-instance activation identity;
- logical node key;
- bounded activation context;
- status and monotonic revision;
- optional `activeAttemptId`;
- store-time lifecycle timestamps.

Activation identity MUST distinguish repeated logical-node activations.
Uniqueness of `(runId, causalForkScope, activationKey)` MUST prevent duplicate
successors and joins without crossing repeated/nested fork scopes.

Implemented node status is exactly `ready`, `executing`, `retry_waiting`,
`unknown`, `gate_waiting`, `join_waiting`, `succeeded`, `failed`, or
`cancelled`. An `executing` node points to a `claimed` or `start_committed`
Attempt. An `unknown` node points to an `unknown` or `reconciling` Attempt.
Every other node status has no active Attempt pointer.

### Attempt

An `Attempt` is the authoritative live ownership record for executable work. It
MUST contain:

- package-owned attempt id;
- run and node-instance identity;
- attempt ordinal or equivalent stable sequence;
- diagnostic owner label;
- package-generated `managerIncarnationId`;
- monotonically changing fencing token;
- lease/heartbeat state based on store transaction time;
- exact status `claimed`, `start_committed`, `unknown`, `reconciling`,
  `succeeded`, `failed`, or `cancelled`;
- status and revision;
- dispatch idempotency identity;
- exact `ExecutorContractPin` and configuration digest;
- bounded known result/fault metadata or durable unknown-outcome state.

Claim MUST create the Attempt and assign
`RunNodeInstance.activeAttemptId` atomically. Node-level mirrors of owner, lease,
or fence data MUST NOT authorize mutations.

Human gates, joins, and other non-executable waiting nodes MUST NOT own an
Attempt.

### RunOutput

A `RunOutput` MUST be immutable and contain:

- package-owned output id;
- run id and optional node/attempt/activation identity;
- bounded name and media/type discriminator;
- bounded package-owned value or artifact reference;
- store-time creation timestamp.

A run or node MAY own multiple outputs. Accepted outputs MUST NOT be overwritten
in place.

### RunEvent

A `RunEvent` MUST be immutable and contain:

- run id;
- strictly ordered durable sequence or cursor;
- bounded event kind and payload;
- store-time creation timestamp;
- relevant run/node/attempt/activation correlation.

Events are audit, observation, and projection input. They MUST NOT be the
authoritative replacement for current run, node, or attempt state.

The implemented Domain layer emits immutable `RunEventIntent` values containing
only run id, a closed event kind, closed correlation, and bounded payload.
Sequence and transaction creation time are assigned later by Store commit.

## Deterministic activation keys

The implemented keys are canonical SHA-256 digests of these exact tuples:

```text
["revo-run", "fork-scope", "v1", "root", runId]
["revo-run", "fork-scope", "v1", parentForkScopeKey, forkActivationId]
["revo-run", "activation-key", "v1",
 nodeKey, forkScopeKey, branchKey-or-null, iteration]
```

`branchKey` is explicit string-or-null and `iteration` is a nonnegative safe
integer. Durable uniqueness remains `(runId, forkScopeKey, activationKey)`.
These helpers isolate supplied causal coordinates; they do not decide graph
progression.

## Gate model

A human gate is a waiting `RunNodeInstance` identified by its runtime activation
id. It has no Attempt or lease.

Exactly one accepted answer MUST be stored as an immutable output associated
with the gate activation. The answer payload and normalized resolution are
distinct: lifecycle uses the normalized resolution for pipeline progression and
does not parse arbitrary output data as control flow.

There is no authoritative `Gate` entity.

## Accepted progression-state extension

ADR 0003 accepts one typed, versioned package-owned logical
`RunProgressionState` per Run. Version 1 has exactly one immutable occurrence
key and one node instance per compiled logical node key. The state is semantic
authority for ordered scalar values with explicit provenance, selector
outcomes, consensus verdicts, normalized gate resolutions, bounded command
receipts and the chosen terminal pair. It is not a pipeline snapshot or an
untyped inference from outputs/events, and it uses `Run.revision` rather than a
second revision.

The accepted operational extensions are `selector_waiting`, `skipped`,
`retiring` and `retired`. `Attempt.progressionClosedAt` fences logical closure
while live/unknown physical work remains reconcilable. A later cleanup
observation cannot change Run progression or terminal outcome.

Each durable semantic receipt retains exact package-owned request content,
complete stable task-output or gate-answer attachment and one bounded
nonrecursive applied-result summary. It cannot nest progression state,
transitions, reducer effects, pipeline values, events, materialized outputs or
unbounded collections.

These extensions are architecture contracts only in this slice. Existing
source status tables and aggregate validators do not implement them yet.

## Join and consensus model

Join readiness MUST be derived from the exact immutable plan and authoritative
predecessor node instances in the matching causal fork scope. Join activation
identity and uniqueness MUST include the scope. No arrival counter or
`JoinArrival` entity is authoritative.

Consensus is expressed by the exact plan and pipeline progression. The run
aggregate stores ordinary activations, attempts, and outputs; it does not own
model selection or a provider-specific consensus runtime.

## Aggregate invariants

- Every accepted node transition MUST CAS and increment `Run.revision`, except
  the cleanup-only retired-attempt observation accepted by ADR 0003.
- An active executable node MUST reference exactly one active Attempt.
- A terminal, retry-waiting, gate-waiting, or join-waiting node MUST NOT retain
  live Attempt authority.
- A result MUST be accepted only for the current active attempt and fence.
- Attempt authority MUST include the manager incarnation; `ownerLabel` is
  diagnostic only.
- Exact executor resolution and configuration verification MUST precede a fresh
  internal Start CAS; dispatch MUST occur only after it commits
  `start_committed`.
- Start, heartbeat, direct/reconciled/cancellation result MUST reject when store
  transaction time is greater than or equal to lease expiry.
- A stale, expired, superseded, or duplicate result MUST NOT mutate state.
- State, attempts, outputs, events, and new activations for one transition MUST
  commit atomically.
- Run terminal status MUST be consistent with all authoritative node state and
  exact plan policy.
- Durable timestamps that affect behavior MUST come from store transaction
  time.
- Recovery of `claimed` and `start_committed` MUST remain distinguishable:
  never-started claim is safe to reclaim, while lost started execution is
  unknown. Either recovery requires database-time lease expiry or an explicit
  durable handoff under the incumbent fence before a new incarnation/fence.
- External payloads and faults MUST be bounded and copied before persistence or
  publication.

After logical terminal closure, a retired-attempt observation may settle only
the physical node and Attempt. It increments only their revisions and MUST NOT
mutate Run, `Run.revision`, `Run.updatedAt`, progression state, terminal
selection, outputs or activations, and MUST NOT emit a public Run event.

The pure implementation prepares revision deltas but does not claim CAS:
one accepted aggregate transition increments Run once, each affected existing
node and Attempt once, and a new Attempt begins at revision zero. Start,
heartbeat/lease renewal, and reconciliation phase-only changes increment only
Attempt. The accepted retired-attempt observation similarly increments only its
physical node and Attempt after progression closure. Rejection and idempotent
no-op increment nothing. Overflow rejects before producing a prospective
change.

## Cancellation

Cancellation intent belongs to `Run` and is durable. It MUST stop new dispatch
eligibility and influence lifecycle decisions for ready, waiting, retrying,
unknown, and active nodes.

Process shutdown or local executor abort MUST NOT mutate run cancellation intent
implicitly.

## Non-goals

The domain does not own:

- manager polling, timers, or process-local concurrency;
- executor adapter calls;
- exact plan retrieval;
- pipeline-owned contracts;
- database transactions or framework types;
- API/auth/product projection concerns.
