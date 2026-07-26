# Run transitions v1

- Status: Draft
- Implementation: Pure domain prospective validation/reducers implemented;
  storage, lifecycle, pipeline decision, and atomic commit not implemented

## Normative language and versioning

BCP 14 keywords are interpreted per RFC 2119/RFC 8174 only when uppercase.
`v1` identifies this contract family; incompatible post-Stable changes require a
new `vN`, while this Draft may still change.

## Scope

This specification defines atomic run transitions used by `RunManager`.
`startRun`, `answerGate`, and `cancelRun` are reached through the public facade.
Attempt, recovery, and progression transitions are package-internal.

## Common transition protocol

Every mutating transition MUST:

1. load the authoritative aggregate and exact persisted plan;
2. begin a store transaction and obtain authoritative database time;
3. validate idempotency, expected run/node/attempt or gate activation state;
4. compute a domain prospective change without committing it;
5. when progression is needed, combine fresh sibling state and the prospective
   outcome/answer into pipeline facts;
6. map the pure pipeline decision to package-owned intents;
7. validate the combined aggregate invariants;
8. CAS expected revisions/fence and atomically commit state, attempts, outputs,
   events, and activations.

On aggregate conflict, lifecycle MUST reload authoritative state and recompute.
It MUST NOT reuse stale sibling facts or pipeline decisions.

## Publicly initiated transitions

### Start run

Start MUST verify the exact plan pin, allocate package-owned ids, and atomically
persist the run plus initial activations and events. The command MUST be
idempotent.

### Answer gate

Answer MUST target one stable runtime gate activation id. It MUST reject a stale
activation, non-waiting node, mismatched plan, or second distinct answer.

The normalized resolution, immutable answer output, gate completion, events,
and successor activations MUST commit atomically. The arbitrary answer payload
MUST NOT be parsed to choose control flow.

### Cancel run

Cancel MUST persist cancellation intent idempotently. It MUST stop new claims
and compute package-owned cancellation progression for ready, waiting, retrying,
unknown, and active nodes.

Active executor cancellation is coordinated after durable intent. Terminal
cancellation MUST not be selected until lifecycle policy accounts for
authoritative active/unknown outcomes.

## Internal executable transitions

### Claim

Claim eligibility MUST be evaluated using transaction time and exact plan
policy. Claim MUST atomically:

- CAS run and node revisions;
- create the Attempt in `claimed`;
- assign package-generated manager incarnation, diagnostic owner label, fence,
  lease, exact executor contract pin/configuration digest, and dispatch
  idempotency identity;
- set `activeAttemptId`;
- update state and append events.

### Start

Attempt Start is a separate internal CAS. It MUST run only after
`resolveExact()` and immutable configuration-digest verification have
succeeded, and MUST then obtain fresh transaction time. It MUST verify active
Attempt, manager incarnation, fence, expected revisions, exact executor pin/digest, and
`transactionNow < leaseExpiresAt`, then atomically record `start_committed` and
its event.

Executor resolution MUST occur before Start, but grants no durable authority.
Executor dispatch MUST occur only after Start commits. Repeating an accepted
Start is idempotent.

### Heartbeat

Heartbeat MUST use store transaction time and renew only the active Attempt for
the current manager incarnation/fence. Caller time MUST NOT determine lease
extension. It MUST reject when `transactionNow >= leaseExpiresAt`.

### Complete

Completion MUST validate and copy bounded outputs, compute the prospective
success, obtain a fresh pipeline decision, and atomically accept the result and
progress the run.

Completion MUST reject stale incarnation/fence and
`transactionNow >= leaseExpiresAt`. The same boundary applies to reconciled and
cancellation results.

### Fail

Known failure MUST normalize a bounded fault and choose, from exact plan policy,
either durable retry waiting or terminal node failure plus pipeline progression.
Retry availability MUST be assigned and evaluated using store transaction time.

### Record unknown

When physical outcome of `start_committed` is unknown, the transition MUST
preserve explicit unknown/reconciling state. It MUST NOT schedule a blind retry.

### Reconcile

Recovery MUST first prove takeover eligibility from transaction time at or
beyond lease expiry, or from an explicit durable handoff recorded by the
incumbent under its active incarnation/fence. Only then may it acquire a new
manager incarnation/fence. It MUST resolve the persisted exact executor contract
and verify the configuration digest before reconciliation. A known reconciled
result then follows the same pre-expiry fenced completion/failure path as a
direct result. A still-unknown result remains durable attention state unless
the exact binding declares execution idempotent and retry policy permits a new
Attempt.

### Expire lease

Expiry eligibility MUST be decided inside the transaction using current store
time; equality is expired. Expiry invalidates the old incarnation/fence before
recovery ownership. `claimed` without committed Start is safely reclaimable.
`start_committed` is conservatively unknown and chooses reconciliation, safe
retry, or durable attention according to the exact executor contract and
idempotency declaration.

An explicit handoff is the only pre-expiry takeover path. It MUST be a durable
CAS written under the incumbent's active incarnation/fence. Process
observation, owner label, and local time are not takeover evidence.

## Pipeline progression

Only private `lifecycle/pipeline/**` modules may use
`@revisium/revo-pipeline`. The public lifecycle index MUST expose explicit
pipeline-free facade contracts. The private seam MUST translate package-owned
run/node/output facts to the public pipeline API and translate the decision
back to package-owned intents.

Fork successors MUST carry causal scope derived from node-instance activation
identity. Join facts, readiness, activation key, and uniqueness MUST use only
predecessor instances in that scope. Repeated/nested fork activations MUST NOT
cross-satisfy.

## Result acceptance and fences

Every executor-originated result MUST prove:

- run and node identity;
- current active attempt id;
- owner or dispatch identity where required;
- current fencing token;
- current manager incarnation;
- exact executor contract pin and configuration digest;
- expected revisions;
- idempotency identity.

Acceptance MUST additionally require `transactionNow < leaseExpiresAt` and be a
CAS. No adapter response, local promise ownership, owner label, process
identity, or in-memory lock can substitute for incarnation/fence.

## Idempotency

Accepted idempotency records MUST bind the key to the semantic command and
result. Repeating the same command returns the same logical result. Reusing a
key with different semantic input is a conflict.

Idempotency records do not prove that an external physical side effect occurred
once.

## Faults

Expected failures MUST be stable, typed, and bounded. At minimum the final
contract MUST distinguish not found, invalid state, stale activation, revision
conflict, stale fence, plan unavailable/mismatch, executor unavailable, unknown
outcome attention, cancellation, and invalid input.

## Non-goals

This specification does not expose internal transitions as public API and does
not define polling cadence, database schema, provider protocols, or pipeline
graph authoring.
