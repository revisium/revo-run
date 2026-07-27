# Run storage v1

- Status: Draft
- Implementation: Package-private type contracts and logical fake conformance
  implemented; durable adapter and database concurrency proof not implemented

## Normative language and versioning

BCP 14 keywords are interpreted per RFC 2119/RFC 8174 only when uppercase.
`v1` identifies this contract family; incompatible post-Stable changes require a
new `vN`, while this Draft may still change.

## Scope

This specification defines the framework-neutral durable store contract
injected into `RunManager`. It specifies observable transactional guarantees,
not a database schema or ORM API.

## Store authority

The store MUST persist authoritative current `Run`, `RunNodeInstance`, and
`Attempt` state plus immutable `RunOutput`, `RunEvent`, idempotency, and
activation records.

Current state MUST be queryable without event replay. Events MUST remain ordered
audit and observation data.

## Transaction time

Every mutation transaction MUST expose one authoritative current time obtained
from the database or equivalent shared durable authority.

That time MUST decide:

- claim and retry eligibility;
- Start CAS eligibility;
- lease creation, renewal, and expiry;
- durable lifecycle timestamps;
- recovery scans whose behavior depends on time.

Caller timestamps and the manager's local clock MUST NOT authorize durable
state changes. Multiple manager processes with skewed local clocks MUST still
agree through store time.

Every lease-sensitive operation MUST treat
`transactionNow >= leaseExpiresAt` as expired.

## Atomic mutation contract

One accepted transition MUST atomically:

- verify idempotency and exact plan pin assumptions;
- CAS expected run, node, attempt, gate activation, and fence state;
- increment monotonic `Run.revision` for an accepted node transition;
- update current state and active-attempt relationships;
- insert immutable outputs and ordered events;
- create deterministic successor/join activations at most once;
- record the command's idempotent logical result.

Partial commit MUST be impossible.

The store MUST expose structured conflicts rather than silently overwriting
newer state. Lifecycle owns reload and recomputation after conflict.

## Claim and attempt authority

Claim MUST atomically create an Attempt in `claimed` and set
`RunNodeInstance.activeAttemptId`. The Attempt MUST persist unique
package-generated manager incarnation, diagnostic owner label, lease, fence,
exact executor contract pin, configuration digest, phase, and revision.

Internal Start MUST be a separate CAS that verifies current incarnation/fence
and pre-expiry transaction time obtained after exact executor resolution and
configuration-digest verification, then records `start_committed` before
external execution.

Fencing tokens MUST change monotonically for successive ownership. Start,
heartbeat, completion, failure, reconciliation, cancellation result, and expiry
MUST verify active Attempt, manager incarnation, fence, and lease boundary.

Store adapters MUST NOT treat node-level mirror fields, process identity,
in-memory locks, or a previously returned candidate as current authority.

## Eligibility and recovery

The store MUST provide bounded, paginated discovery for manager-internal work,
including:

- claimable node activations;
- due retries;
- renewable or expired leases;
- attempts requiring recovery or reconciliation;
- runs with pending cancellation or pipeline progression;
- durable observation events after a cursor.

Discovery returns candidates only. Authoritative reservation happens in the
subsequent claim/CAS transaction.

Recovery acquisition MUST atomically assign a new manager incarnation/fence
before heartbeat, reconcile, cancellation result, or result acceptance. Its CAS
MUST succeed only when transaction time is at or beyond lease expiry, or when an
explicit durable handoff exists that the incumbent wrote under its active
incarnation/fence. Local time, process observation, and owner labels MUST NOT
authorize takeover. The store MUST distinguish `claimed` without committed
Start from `start_committed`.

Handoff MUST invalidate the incumbent's ability to renew or commit results and
MUST be consumed atomically by one successor ownership acquisition. A manager
MUST NOT report a drained/stopped state until every abandoned local Attempt has
such a committed handoff or has otherwise reached a durable terminal state.

Handoff reason is a closed durable value:

- `manager_shutdown` for ordinary quiesce/drain/stop abandonment;
- `manager_start_failure` only for failure of an actual manager starting cycle;
- `manager_progression_unavailable` when safe lifecycle work cannot continue
  without the real pipeline progression bridge;
- `manager_recovery_failure` when supervisor recovery cannot safely continue.

The exact reason MUST be preserved by the handoff record, semantic idempotency
request, replay, and `attempt.handoff_recorded` event.

Ordering and pagination MUST be deterministic and starvation-aware. Query
limits MUST be bounded.

## Exact plan pin

The store persists only plan id, revision, and digest on `Run`. It MUST NOT
persist the full execution plan or live plan-source objects.

Store mutation contracts MAY verify a caller-supplied expected pin loaded
internally by lifecycle, but pipeline-owned types MUST NOT enter storage
contracts.

## Activations

The store MUST enforce scoped activation uniqueness using run id, causal fork
scope, and activation key. Duplicate activation attempts within one scope MUST
resolve idempotently; repeated/nested fork scopes MUST remain isolated.

Join readiness MUST NOT be persisted as an authoritative arrival counter. There
is no authoritative `JoinArrival` or `Gate` table requirement.

## Events and durable observation

Events MUST have a stable per-run order and cursor. The store MUST atomically or
transactionally consistently read an immutable current snapshot plus event
high-watermark cursor. It MUST support bounded reads after that cursor without a
snapshot/event gap.

A store adapter MAY provide notification or blocking wait as an optimization.
Notification loss MUST NOT lose durable state; manager subscription logic MUST
resume by reading state/events.

Observation contracts MUST support pull backpressure, bounded page/read-ahead
sizes, and bounded cursor validation. `waitForTerminal()` uses the same reads.

Retention policy, if any, MUST preserve the documented cursor and snapshot
recovery contract.

## Idempotency

Idempotency identity MUST be scoped so unrelated runs or operation kinds cannot
collide accidentally. The store MUST bind an accepted key to a normalized
semantic request and logical result.

Same key plus same request returns the existing result. Same key plus different
request returns a conflict.

## Framework neutrality

Core storage types MUST NOT expose:

- Prisma or another ORM;
- SQL driver connections;
- DBOS, queue, or scheduler primitives;
- NestJS or transport types;
- provider-specific timestamps or transaction handles.

A concrete adapter may use those tools privately after a separate accepted
design. Concurrency guarantees require real database E2E proof; an in-memory fake
is insufficient.

## Required concurrency proof

A conforming durable adapter MUST prove:

- competing multi-process claims create one active Attempt;
- every manager start uses a unique incarnation even when owner label repeats;
- skewed local clocks cannot expire or extend leases incorrectly;
- Start/heartbeat/all result sources reject at or after lease expiry;
- claimed -> exact resolve/config verification -> fresh Start CAS -> dispatch
  ordering is durable;
- never-started claim recovery differs from conservative started recovery;
- recovery takeover succeeds only at database-time expiry or through a durable
  fenced handoff;
- exact executor pin/config digest survives recovery;
- stale incarnation/fence rejects heartbeat and results;
- aggregate conflicts reload and recompute join progression;
- causal-scope activation uniqueness prevents cross-fork joins;
- gate answer races accept one immutable answer;
- unknown non-idempotent outcomes are not redispatched;
- cancellation/result races preserve lifecycle policy;
- subscription exposes a consistent `initial` snapshot/high-watermark and
  iteration resumes strictly after its cursor with bounded reads;
- terminal `initial` performs no later read/wait and a terminal item performs no
  read/wait after it;
- drain timeout commits fenced handoff before stopped and the stopped manager
  writes nothing;
- all transition artifacts commit atomically.
