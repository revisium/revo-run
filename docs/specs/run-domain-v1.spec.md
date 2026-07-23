# Run Domain v1

- Status: Draft
- Implementation: none
- Public export: none

## Aggregate

```text
Run
├── RunNodeInstance*
│   ├── Attempt*
│   └── RunOutput*
└── RunEvent*
```

## Target entities

### Run

Owns run id, pinned execution-plan identity/revision/digest, lifecycle status,
monotonic aggregate revision, timestamps, terminal summary, and cancellation
intent. It never stores the full host plan.

Draft statuses:

- `pending`
- `running`
- `waiting`
- `succeeded`
- `failed`
- `cancelled`

### RunNodeInstance

One activation of one logical plan node. It owns activation key, node key/kind,
iteration and branch coordinates, parent/fork/join relationships, status,
revision, retry availability, and optional `activeAttemptId`. A monotonic claim
epoch may be added only if an accepted concurrency proof requires it.

The node does not own live worker, lease, or fence authority. Any mirrored claim
columns are explicitly historical/projection data.

Draft statuses:

- `blocked`
- `ready`
- `claimed`
- `running`
- `waiting`
- `retry_scheduled`
- `succeeded`
- `failed`
- `skipped`
- `cancelled`

### Attempt

One executable-node claim/execution lifecycle and the authoritative live claim
record. It stores attempt number, worker/owner identity, fencing token, lease
interval, heartbeat/execution timestamps, and normalized terminal outcome. Gate
nodes never have attempts.

### RunOutput

An immutable named/typed payload or artifact reference emitted by a node,
attempt, gate answer, or run transition. A node may have multiple outputs.
Output identity/idempotency prevents duplicate retry commits.

### RunEvent

An immutable ordered audit record with run sequence, event type, occurrence
time, actor/correlation metadata, and bounded payload. Events are not current
state authority.

## Aggregate invariants

- Run plan pins never change and lifecycle commands must supply a matching
  host-owned plan; no full plan snapshot belongs to the aggregate.
- Terminal states never transition.
- Every accepted node transition CASes and increments `Run.revision`.
- A revision conflict discards both the prospective change and pipeline
  decision, reloads the authoritative aggregate/siblings, and recomputes from
  domain precondition validation through combined intent validation.
- One activation key identifies at most one node instance per run.
- Attempt numbers and fencing tokens increase monotonically per node instance.
- Claim creates the Attempt and sets `activeAttemptId` atomically.
- Only the active Attempt's owner/lease/fence may authorize heartbeat,
  completion, expiry, retry, or recovery.
- A stale or mismatched fence cannot mutate state or append successful outputs.
- Outputs are append-only.
- Event sequence is unique and increasing per run.
- A transaction never exposes state without its outputs/events or vice versa.
- Gate nodes wait without attempt or lease and accept at most one immutable answer.
- Join readiness is derived from fresh sibling facts; aggregate revision CAS
  provides liveness while unique `(runId, activationKey)` prevents duplication.
  No arrival counter is authoritative.

Exact names remain Draft until behavior tables and storage semantics stabilize.
