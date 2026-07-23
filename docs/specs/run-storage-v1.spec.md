# Run Storage v1

- Status: Draft
- Implementation: none
- Public export: none
- Schema/migrations: none

## Purpose

Define framework-neutral transactional semantics and a high-level PostgreSQL
shape. This is not a Prisma schema and does not authorize migrations.

## High-level state tables

### `runs`

| Field group | Purpose                                         |
| ----------- | ----------------------------------------------- |
| identity    | run id, plan id/revision/digest                 |
| lifecycle   | status, aggregate revision, cancellation intent |
| timing      | created, updated, terminal timestamps           |
| terminal    | bounded normalized summary/fault                |

### `run_node_instances`

| Field group | Purpose                                                    |
| ----------- | ---------------------------------------------------------- |
| identity    | node instance id, run id, logical node key, activation key |
| topology    | kind, iteration, parent/fork/branch/join coordinates       |
| lifecycle   | status, revision, retry availability                       |
| claim link  | nullable activeAttemptId; optional monotonic claim epoch   |
| data        | bounded node input and normalized result summary           |

Required uniqueness includes `(run_id, activation_key)`.
Node rows do not authorize live claims. Mirrored owner/lease/fence values, if
later added for reads, are historical/projection fields only.

### `run_attempts`

| Field group | Purpose                                                       |
| ----------- | ------------------------------------------------------------- |
| identity    | attempt id, node instance id, monotonically increasing number |
| claim       | authoritative worker/owner, fencing token, and lease interval |
| lifecycle   | claimed, started, heartbeat, terminal timestamps/status       |
| outcome     | bounded normalized failure/usage summary                      |

Required uniqueness includes `(node_instance_id, attempt_number)` and the
appropriate fence identity.

Claim atomically inserts the Attempt and sets the node's `activeAttemptId`.
Heartbeat, completion, expiry, retry, and recovery authorize against that active
Attempt, never against a copied node field. Gate nodes have no Attempt.

### `run_outputs`

| Field group | Purpose                                              |
| ----------- | ---------------------------------------------------- |
| identity    | output id and idempotency key                        |
| owner       | run, node instance, optional attempt                 |
| contract    | name, type/schema identity                           |
| value       | bounded JSON payload or immutable artifact reference |
| audit       | created time and actor/correlation identity          |

Outputs are insert-only and multiple per node/attempt.

### `run_events`

| Field group | Purpose                                    |
| ----------- | ------------------------------------------ |
| order       | run id plus strictly increasing sequence   |
| identity    | event id, type, occurrence time            |
| context     | node/attempt, actor, correlation/causation |
| payload     | bounded audit payload                      |

Events are insert-only. Unique `(run_id, sequence)` orders the timeline.

## Deliberately absent tables

- No authoritative `gates`: a gate is a waiting node instance.
- No authoritative `join_arrivals`: readiness is derived from plan topology and
  node instances.
- No full execution-plan snapshot: `runs` stores only host plan
  identity/revision/digest pins.
- No queue table owned by core: eligible-work queries read authoritative state.
- Product inbox/projection tables are host-owned and disposable.

## Transactional ports

The target command port must support atomic create, claim, start/heartbeat,
complete, fail/retry, lease-expire, gate-answer, join-activate, and cancel
operations with explicit preconditions.

Every operation that accepts a node transition must CAS and increment
`runs.revision` in the same transaction. Its write input contains the
domain-validated prospective state/output change plus package-owned
successor/join/wait intents, never pipeline-owned types. Storage CASes expected
Run/node/Attempt revisions (or Run/gate revisions for a gate) before committing
prospective state, outputs, events, and activations together.

If any CAS conflicts, lifecycle discards the whole prospective/combined intent,
reloads current nodes/attempts/siblings, reruns domain precondition validation,
reconstructs `PipelineFacts` from authoritative siblings plus the newly
prospective outcome/answer, recomputes the pipeline decision and package-owned
intents, and reruns combined domain validation before retrying.

The target query port may expose:

- claimable nodes at `now`, ordered and limited;
- due retries at `now`;
- expired active-Attempt leases at `now`;
- run/node detail and ordered outputs/events.

Query results are candidates, not claims. Every mutation rechecks plan pins,
aggregate/node revision, active Attempt, lease, fence, uniqueness, and
idempotency constraints.

## PostgreSQL E2E requirements

Before a concrete adapter is accepted, real PostgreSQL tests must prove:

- two workers cannot both claim one node;
- expired/reassigned fences reject stale completion;
- due retry selection and claim are race-safe;
- concurrent final branch completions conflict on `Run.revision`, reload fresh
  sibling facts, and create one join activation;
- unique `(run_id, activation_key)` independently rejects duplicate join inserts;
- concurrent gate answers accept exactly one immutable answer;
- state, outputs, events, and activations roll back together.

An official Prisma adapter may use Prisma internally and in E2E tests. Core
contracts and domain tests must not import Prisma. Exact columns, indexes,
isolation level, locking clauses, retention, partitioning, and migration
ownership remain open Draft decisions.
