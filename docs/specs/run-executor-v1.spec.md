# Run executor v1

- Status: Draft
- Implementation: Package-private data, verification, faults, type-only ports,
  hostile observation normalization, reconciliation preparation, and
  unknown/running lifecycle commits implemented; terminal progression,
  cancellation invocation, and manager orchestration not implemented

## Normative language and versioning

BCP 14 keywords are interpreted per RFC 2119/RFC 8174 only when uppercase.
`v1` identifies this contract family; incompatible post-Stable changes require a
new `vN`, while this Draft may still change.

## Scope

This specification defines the injected executor boundary used internally by
`RunManager`. It covers dispatch, cancellation, reconciliation, idempotency,
and unknown outcomes without exposing provider mechanics in core contracts.

## Executor resolution

The exact immutable execution plan supplies one bounded executor binding for
each executable node. `ExecutorResolver.resolveExact()` MUST resolve the exact
persisted contract pin without mutating it.

A binding MUST include:

- `ExecutorContractPin` containing adapter id, contract revision, and contract
  digest;
- bounded immutable adapter configuration;
- exact configuration digest;
- an explicit `idempotentExecution` declaration.

Missing `idempotentExecution` MUST be treated as `false`.

Attempt MUST persist the contract pin and configuration digest before dispatch.
Recovery MUST use them and MUST NOT resolve latest, default, nearest, or
compatible behavior.

Resolution or digest mismatch MUST be normalized to stable bounded package
faults. The resolver MUST NOT place credentials, clients, functions, or live
objects in the execution plan or durable store.

## Adapter operations

An adapter MUST implement:

```ts
execute(input): Promise<ExecutorResult>
```

It MAY implement:

```ts
reconcile(input): Promise<ReconcileResult>
cancel(input): Promise<CancelResult>
```

The package-private TypeScript shapes are implemented. All inputs MUST be package-owned immutable
snapshots and include only the bounded execution data, attempt identity,
idempotency identity, and cancellation signal needed by the adapter.

The manager owns lease heartbeat. Executor code MUST NOT receive a store,
transaction, fencing mutation primitive, manager, or pipeline decision API.

## Dispatch protocol

Claim MUST atomically:

1. select eligible work using store transaction time;
2. create the authoritative `Attempt` in `claimed`;
3. set `RunNodeInstance.activeAttemptId`;
4. persist manager incarnation, fence, lease, executor pin/config digest;
5. append required events.

A separate internal Start CAS MUST then:

1. run only after `resolveExact()` succeeds and the immutable configuration
   digest is verified against the claimed Attempt;
2. obtain fresh store transaction time after that resolution/verification;
3. verify active Attempt, manager incarnation, fence, and
   `transactionNow < leaseExpiresAt`;
4. transition to `start_committed` and append its event atomically.

Only after Start commits may the manager invoke `execute()` on that already
resolved exact executor. A resolution failure or digest mismatch MUST leave the
Attempt unstarted. Resolution performed before Start grants no durable
authority; the fresh Start CAS is still required.

Every direct, reconciled, or cancellation result MUST be treated as untrusted
until a store transaction verifies active Attempt, incarnation, fence, expected
revisions, idempotency key, exact executor pin/digest, and
`transactionNow < leaseExpiresAt`. Equality with expiry is expired. A stale or
duplicate result MUST NOT mutate the run.

## Result classes

The adapter boundary MUST distinguish:

- known success with bounded outputs;
- known failure with a bounded normalized fault;
- caller/manager cancellation observation;
- unknown outcome.

Thrown exceptions, process termination, transport loss, timeout, and malformed
adapter responses MUST be normalized. A transport error alone MUST NOT be
classified as known failure when an external side effect may have occurred.

Outputs MUST be copied, bounded, typed, and stored as immutable `RunOutput`
records. Provider stack traces and unbounded diagnostic payloads MUST NOT cross
the public or durable boundary.

## Unknown outcomes

The package does not guarantee physical exactly-once execution.

When a `start_committed` outcome is unknown, the manager MUST persist that state
and:

1. establish takeover eligibility from database transaction time at or beyond
   lease expiry, or from an explicit durable handoff written under the
   incumbent incarnation/fence;
2. acquire recovery ownership with a new manager incarnation and fence;
3. resolve the persisted exact executor contract and verify its configuration
   digest;
4. invoke `reconcile()` when the adapter provides it;
5. accept a reconciled known result only before lease expiry through the active
   incarnation/fence and CAS;
6. keep a still-unknown non-idempotent execution in durable attention/recovery
   state;
7. permit a new execution only when the exact binding explicitly declares
   execution idempotent and retry policy allows it.

A `claimed` Attempt without committed Start is known not to have been dispatched
by this protocol. It MAY be recovered only after the same expiry-or-handoff
takeover gate, under a new incarnation/fence, and MUST repeat exact
resolution/configuration verification before a fresh Start CAS.

Process death detection, local timer expiry, owner-label comparison, or an
unreachable incumbent MUST NOT by itself authorize takeover.

The manager MUST NOT infer idempotency from an idempotency key, adapter name,
transport, or provider. The declaration belongs to the exact immutable binding.

Reconciliation calls MAY repeat. An adapter that implements `reconcile()` MUST
therefore make reconciliation observational and idempotent.

## Heartbeats and lease loss

Manager heartbeats MUST renew only the active Attempt for the current manager
incarnation/fence and only when `transactionNow < leaseExpiresAt`. A failed
renewal, equality with expiry, or lease loss MUST abort local execution when
possible and make its eventual result stale.

Executor cooperation with an abort signal reduces unnecessary work but does not
replace fencing.

## Cancellation

When durable run cancellation reaches an active attempt, the manager MAY invoke
adapter `cancel()`. The call MAY repeat and its result is advisory:

- confirmed cancellation may produce a known cancelled outcome;
- unsupported or unconfirmed cancellation leaves the outcome active or unknown;
- a concurrently returned execution result is accepted only if lifecycle policy
  plus incarnation/fence and pre-expiry transaction time allow it.

The manager MUST NOT equate process shutdown, local abort, or a successful
cancel request with durable terminal cancellation.

## Retry safety

Known failures follow exact plan retry policy. Unknown outcomes follow the
stricter rules above. Retry availability MUST be stored durably and evaluated
against database-authoritative time.

## Non-goals

This specification does not define:

- provider SDKs or protocols;
- agent-runtime or scripts adapters;
- queue transport;
- credential management;
- model, prompt, permission, or workspace resolution;
- physical process isolation.

## Implementation boundary

The implemented package-private slices include immutable invocation/output
snapshots, pure exact binding verification, executor fault refinements,
type-only executor/resolver ports, exact resolve plus Start preparation,
lifecycle-owned hostile result normalization, reconciliation begin under fresh
authority, and fenced direct-unknown/reconciled-running/reconciled-unknown
commits. Known terminal observations are copied and returned as
`requires_progression` without a Store write. Retry calculation, terminal
pipeline progression, cancellation invocation, manager orchestration,
registry/adapters/providers, and composition remain unimplemented.
