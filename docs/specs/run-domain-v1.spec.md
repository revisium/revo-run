# Run domain v1

- Status: Draft
- Implementation: Not implemented

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

Run status MUST distinguish non-terminal operation, durable cancellation intent,
and terminal success, failure, or cancellation. Exact enum names remain Draft.

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

Node status MUST distinguish at least ready, claimed/running, retry waiting,
unknown/reconciling, human-gate waiting, join waiting, and terminal outcomes.
Exact enum decomposition remains Draft.

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
- phase distinguishing at least `claimed`, `start_committed`, unknown/reconciling,
  and terminal outcomes;
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

## Gate model

A human gate is a waiting `RunNodeInstance` identified by its runtime activation
id. It has no Attempt or lease.

Exactly one accepted answer MUST be stored as an immutable output associated
with the gate activation. The answer payload and normalized resolution are
distinct: lifecycle uses the normalized resolution for pipeline progression and
does not parse arbitrary output data as control flow.

There is no authoritative `Gate` entity.

## Join and consensus model

Join readiness MUST be derived from the exact immutable plan and authoritative
predecessor node instances in the matching causal fork scope. Join activation
identity and uniqueness MUST include the scope. No arrival counter or
`JoinArrival` entity is authoritative.

Consensus is expressed by the exact plan and pipeline progression. The run
aggregate stores ordinary activations, attempts, and outputs; it does not own
model selection or a provider-specific consensus runtime.

## Aggregate invariants

- Every accepted node transition MUST CAS and increment `Run.revision`.
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
