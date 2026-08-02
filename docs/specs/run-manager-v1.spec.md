# RunManager v1

- Status: Draft
- Implementation: Narrow one-task-to-terminal MVP implemented over the logical
  Store contract; broader v1 operations and database proof remain unimplemented

## Normative language and versioning

BCP 14 keywords are interpreted per RFC 2119/RFC 8174 only when uppercase.
`v1` identifies this contract family; incompatible post-Stable changes require a
new `vN`, while this Draft may still change.

## Scope

This specification defines the reusable public facade that manages many durable
runs. Exact TypeScript names and shapes remain Draft until shipped together with
implementation, declarations, tests, exports, and README.

## Construction

The target factory is:

```ts
createRunManager({
  store,
  plans,
  executors,
  ids,
  clock,
  scheduler,
  coordination,
});
```

Required public adapters (each source is validated before private adaptation):

- `store`: durable transaction, query, eligibility, event, and
  database-authoritative time contract;
- `plans`: exact lookup returning package-owned `RunExecutionPlanDocument`;
- `executors`: `resolveExact()` by `ExecutorContractPin`;
- `ids`: purpose-specific Attempt, output, lifecycle-idempotency, handoff, and
  manager-incarnation id generation. Claim idempotency and later Start handoff
  use distinct purposes; neither reuses the other's generated id.

Optional inputs:

- `clock`: process-local waits, timeouts, wakeups, and test control only;
- `scheduler`: process-local enqueue and abortable waits only;
- `coordination`: diagnostic `ownerLabel`, polling, heartbeat, lease,
  concurrency, observation, and drain policy.

`ownerLabel` MUST NOT authorize durable work. Every transition from stopped to a
new start cycle MUST allocate a unique package-generated
`managerIncarnationId`.

Construction MUST copy and validate options. Mutable consumer configuration
MUST NOT change a running manager implicitly.

## Public facade

The implemented MVP `RunManager` provides only:

- `start()`;
- `stop(options?)`;
- `startRun(command)`;
- `getRun(runId)`;

`answerGate`, `cancelRun`, `listRuns`, `subscribe`, and `waitForTerminal` remain
Draft v1 targets and are not root exports.

Claim, attempt start, heartbeat, completion, failure, lease expiry, recovery,
reconciliation, and pipeline-progression operations MUST remain internal.

## Manager lifecycle

The serialized lifecycle states are:

```text
stopped -> starting -> running -> quiescing -> draining -> stopped
```

`start()` MUST be safe under repeated/concurrent calls. During `starting` it
MUST allocate a new manager incarnation, recover owned/expired/unknown work, and
only then enter `running` and claim new work.

`stop()` MUST move through quiescing and draining:

- quiescing stops new claims and new execution starts;
- active heartbeats, reconciliation, cancellation responses, direct results,
  and their fenced durable commits continue;
- draining waits for local executor calls and required durable writes;
- timeout aborts local work only after lifecycle records an explicit durable
  handoff under the active manager incarnation and fence;
- `cancelRun()` is never implied.

After entering `stopped`, no timer, observer, executor promise, abort handler, or
late callback owned by that start cycle MAY write. A later start uses a new
incarnation.

| State     | `start()`                                             | `stop()`                                                   | Allowed manager writes                                  |
| --------- | ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| stopped   | allocates incarnation and enters starting             | resolves idempotently                                      | none until starting owns its incarnation                |
| starting  | joins the in-progress start                           | requests quiesce; manager MUST NOT enter claimable running | recovery or durable handoff only                        |
| running   | resolves idempotently                                 | enters quiescing                                           | all lifecycle writes                                    |
| quiescing | waits for stop or returns a stable lifecycle conflict | joins the in-progress stop                                 | heartbeat/result/cancel/reconcile and handoff, no claim |
| draining  | waits for stop or returns a stable lifecycle conflict | joins the in-progress stop                                 | same fenced completion/handoff writes, no new Start     |

Starting failure MUST clean up or explicitly hand off acquired authority under
its active incarnation/fence before returning to stopped. `drain: false`, if
retained by the final API, means immediate local abort plus that durable fenced
handoff; it MUST NOT skip ownership cleanup. If handoff cannot commit, the
manager MUST NOT report `stopped` while it still owns writable work. Concurrent
callers MUST observe one serialized start or stop result.

The starting-cycle cleanup path uses `manager_start_failure`. It MUST NOT reuse
that reason for ordinary shutdown, unavailable pipeline progression, or a later
recovery-loop failure; those use `manager_shutdown`,
`manager_progression_unavailable`, and `manager_recovery_failure`
respectively.

Stopping the manager MUST NOT terminate the host process. Multiple manager
instances MAY coordinate through the same store; durable correctness MUST not
depend on one process.

## Run lifecycle

### `startRun`

`startRun()` MUST accept:

- an exact immutable plan pin;
- bounded immutable run input;
- an idempotency key;
- optional bounded actor or correlation metadata.

It MUST load and verify the exact plan, allocate package-owned identifiers, and
atomically persist the run, initial node activations, outputs/events required by
creation, and the plan pin. Repeating the same accepted idempotency key MUST
return the same logical result. Reusing it with different semantic input MUST
return a conflict.

### `answerGate`

`answerGate()` MUST target `runId` plus the stable runtime gate activation id.
It MUST accept one normalized resolution, explicit bounded scalar progression
values and one bounded immutable answer output. Resolution and values MUST NOT
be inferred from the arbitrary answer payload. It MUST load the exact persisted
plan automatically.

Answer acceptance, output insertion, gate completion, audit events, and
pipeline progression MUST be one fenced/CAS transaction. A duplicate identical
command is idempotent; a second distinct answer is a conflict.

### `cancelRun`

`cancelRun()` MUST persist durable cancellation intent idempotently. It MUST
prevent new dispatch, coordinate optional executor cancellation, and progress
the run to a terminal outcome only after lifecycle policy accounts for active
and waiting nodes.

Cancellation MUST NOT accept unfenced executor outcomes and MUST NOT assume that
an adapter cancellation request stopped an external side effect.

## Queries

`getRun()` MUST return one immutable package-owned snapshot or absence.

`listRuns()` MUST use bounded filters and stable cursor pagination. Ordering and
cursor semantics MUST be deterministic and documented before implementation.

Snapshots MUST expose consumer-relevant durable state without leaking mutable
store rows, transaction handles, executor objects, pipeline-owned values, or
provider-specific payloads.

## Observation

`subscribe()` MUST return a pull-based `RunSubscription` `AsyncIterable`. It
MUST NOT register a push callback. The subscription MUST expose:

```ts
readonly initial: {
  readonly snapshot: RunSnapshot;
  readonly cursor: RunEventCursor;
};
```

Subscription creation MUST obtain that immutable snapshot and high-watermark
cursor transactionally consistently. Iteration MUST yield only bounded
cursor-bearing items/pages strictly after `initial.cursor`; it MUST NOT replay
the initial snapshot as an iterator item. Consumer pull controls backpressure;
resume cursor and read-ahead/buffer limits MUST be bounded. Notification MAY
wake a blocked pull but MUST NOT carry authority.

If `initial.snapshot` is terminal, the iterator MUST be already complete: its
first `next()` MUST return `done: true` without polling, waiting for
notification, or yielding an item. If iteration yields an item whose snapshot
is terminal, the following `next()` MUST immediately return `done: true`
without another store read or wait.

`waitForTerminal()` MUST use the same snapshot/high-watermark/cursor protocol,
not a parallel callback or in-memory-only path. It waits until terminal status,
abort, or bounded timeout and MAY resume from a supplied cursor.

## Multi-run scheduling

The manager MUST enforce its process-local concurrency limit across all runs it
serves. Fairness policy MUST be deterministic enough to avoid starvation and
MUST be expressed independently of durable correctness.

Claims, retries, leases, and fences MUST use store transaction time. Local clock
skew between managers MUST NOT permit duplicate authoritative ownership.

### Accepted progression coordination

The private lifecycle progression method owns exactly one transaction attempt
and returns a fixed retryable `REVISION_CONFLICT` only after complete rollback
of an approved revision/absence conflict. It MUST NOT reload, decode, reduce or
open a second transaction.

The future manager coordinator owns at most four attempts: one initial attempt
and three contention retries. One external idempotency key remains stable.
Before each retry it MUST reload the exact plan and complete authoritative
aggregate, obtain fresh transaction time, recompute projection/command/reduction
and expectations, and supply a fresh allocation seed. Initialization also uses
a fresh occurrence key for each abandoned attempt. Cancellation is checked
before each plan load and lifecycle attempt. Exhaustion returns a fixed bounded
revision-conflict fault.

This coordination contract is Accepted by ADR 0003. The MVP implements one
transaction attempt; bounded manager contention retries remain unimplemented,
so this specification does not claim end-to-end retry proof.

Every claimed Attempt MUST persist the current `managerIncarnationId`. A
recovery manager MAY acquire ownership only when transaction time is at or
beyond lease expiry, or when an explicit durable handoff exists that was
written by the incumbent under its then-active incarnation/fence. Process
observation, missing heartbeats in local memory, and local time MUST NOT
authorize takeover. Recovery MUST acquire a new incarnation/fence before
heartbeat, reconciliation, cancellation result, or result acceptance.

## Failure model

Expected conflicts, missing plans, unavailable executors, invalid gate
activations, aborted waits, and manager lifecycle misuse MUST use stable bounded
faults. Provider exceptions and unbounded messages MUST be normalized before
entering durable state or public results.

## Non-goals

The manager does not own:

- API transports, auth, product projections, or deployment;
- plan authoring, profile resolution, or pipeline compilation;
- concrete database clients or migrations;
- executor credentials, models, prompts, agents, scripts, or workspaces;
- physical exactly-once execution.

## Required package proof

Before the facade ships, declarations and the exact packed consumer MUST prove:

- `subscribe()` returns `RunSubscription`, not callback unsubscribe;
- `RunSubscription.initial` carries the consistent snapshot/cursor and
  iteration starts strictly after it, is already complete for a terminal
  initial snapshot, and completes after yielding a terminal item;
- manager/root declarations expose no pipeline-owned type or cast;
- composition accepts the store while manager implementation imports no
  storage/domain/pipeline module, imports lifecycle only through its public
  index, and uses explicit facade contracts instead of `Parameters<>` or
  `ReturnType<>` inference;
- no low-level attempt operation is public.
