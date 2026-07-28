# ADR 0003: Private pipeline reduction and durable progression state

- Status: Accepted
- Date: 2026-07-28
- Implementation: Dependency-free domain and abstract Store foundation
  implemented; pipeline adapter, lifecycle coordination, and manager not
  implemented

## Context

`revo-run` must progress a durable Run with the portable, pure reducer shipped
by `@revisium/revo-pipeline`. The packages have deliberately different
responsibilities:

- `revo-pipeline` decodes immutable compiled definitions and reduces a
  package-owned snapshot plus one command into an ordered semantic effect
  batch;
- `revo-run` owns Run, node, Attempt, output and event state, authoritative
  transaction time, CAS/fences, idempotency, persistence and later manager
  coordination;
- a host owns compilation and exact plan publication, concrete storage and
  executor adapters.

Inferring pipeline facts from generic rows or outputs would lose provenance,
selector outcomes, consensus verdicts, gate resolutions and exact replay
meaning. Persisting pipeline-owned types would couple the Run Store to another
package's representation. Committing an executor result before graph
progression would allow a crash to strand the Run between the two changes.

## Decision

### Package direction and private seam

The dependency direction is only:

```text
revo-run -> @revisium/revo-pipeline
```

`revo-pipeline` has no knowledge of `revo-run`. Only production files beneath
`src/lifecycle/pipeline/**` may import the pipeline package, and only through
its public root. Every outer boundary uses copied, bounded, package-owned
`revo-run` values. Pipeline imports, types and casts are forbidden in `spec`,
`errors`, `domain`, `storage`, `ports`, the public lifecycle index, `manager`,
`composition`, root exports and declarations reachable from those surfaces.

The exact plan document keeps the compiled pipeline as bounded `JsonValue`.
The private seam decodes that value once per transaction attempt with
`decodeCompiledPipeline`, builds a reducer snapshot and command, calls
`reducePipeline` exactly once, and exhaustively maps the complete ordered
effect batch to one package-owned intent. It never compiles, repairs, replaces
or caches the persisted compiled plan.

Intent application folds the batch over an evolving in-memory aggregate.
Later effects observe entities created or updated by earlier effects. Repeated
updates of one identity produce one final Store delta while their intermediate
events retain reducer order. Only the first effect is the command-origin effect
bound to the durable receipt; following effects are reducer-produced secondary
progression effects.

Initialization treats its uninitialized Run as an unpersisted draft: the
created Run and every created entity persist at revision zero even when the
fold updates them internally. Existing identities persist at exactly their
prior revision plus one. The batch grammar permits exactly one command-origin
effect at index zero; only activation, selector-completion, join-completion and
terminalization effects may follow.

Retired-attempt cleanup receipts carry one bounded terminal observation
(`attemptId`, `nodeKey`, status, normalized fault and terminal time). Cleanup
may replace unknown evidence only when the final Attempt matches that exact
observation; same-status retirement preserves its fault byte-for-byte.
Failed cleanup observations accept only the normalized executor-failure fault
taxonomy; uncertainty and cancellation codes are not failures.

Secondary effects are also closed and ordered: selector and join completion
identities are unique, every existing-node delta follows the legal status
matrix, and at most one terminalization effect may appear as the final effect
in the batch. Join completion is the progression equivalent of
`join_succeeded`: it requires exact evolving `join_waiting` authority and
completes the join before any same-batch successor activation. `join_ready`
remains the separate operational transition to `ready`.

No new package export is introduced. The package root remains runtime-empty.

### Durable semantic authority

One logical, typed and versioned `RunProgressionState` belongs to the Run
aggregate. It records:

- one immutable occurrence key for the Run;
- phase `uninitialized`, `active` or `terminal`;
- ordered scalar values with explicit init, task or human-gate provenance;
- ordered logical node state;
- normalized consensus candidate verdicts;
- normalized human-gate resolutions;
- bounded durable command receipts;
- the selected terminal node and outcome.

This is a logical Store contract, not a prescribed JSON column or relational
schema. An adapter may normalize it privately but must reconstruct the exact
value and commit it atomically. `Run.revision` is its CAS revision; no second
progression revision exists. Pipeline-owned snapshots are never persisted.

Each semantic command receipt stores its canonical package-owned request, its
complete stable host attachment and a bounded, versioned,
`RunProgressionAppliedReceipt`. The applied receipt is nonrecursive: it cannot
contain progression state, a transition, pipeline values, reducer effects,
events, materialized outputs, a runtime aggregate or an unbounded collection.

### One occurrence and operational nodes

Version 1 has exactly one pipeline occurrence per Run. A full restart is a new
Run; bounded rework is represented by distinct compiled node keys. One logical
node key maps to exactly one node instance in the occurrence. Duplicate keys
are corruption.

Progression adds the operational node states:

- `selector_waiting` for branch, fork and consensus selectors;
- `skipped` for a task's explicit skipped terminal outcome;
- `retiring` when logical closure retains live or unknown physical work;
- `retired` when no live Attempt remains.

Fork and join mapping retains the existing causal fork scope. Join readiness
is derived from exact compiled structure and authoritative predecessor facts
in that scope; no authoritative `JoinArrival` is introduced.

The caller supplies a bounded occurrence key for initialization and one
attempt-scoped allocation seed. Lifecycle allocates neither. Runtime node,
activation and output IDs are deterministically derived from the seed and
effect coordinates. A rolled-back contention attempt discards the seed,
derived IDs and initialization occurrence key.

### Human gate and task values

A human-gate answer separates:

- its runtime gate activation target;
- normalized control-flow resolution;
- explicit bounded scalar progression facts;
- an arbitrary bounded immutable answer output.

No layer parses the answer output to infer resolution or facts. All four
values, gate completion, reducer consequences, events and idempotency result
commit atomically.

Only a succeeded task command may contain ordinary outputs and explicit scalar
progression values. Failed, cancelled and skipped commands reject any
`values` member, including an empty array, before I/O or idempotency lookup.
The private seam never infers reducer values from arbitrary executor outputs.

### Exact terminal bindings

The package-owned exact plan document carries a bounded terminal-binding
array. A binding identifies pipeline terminal node key and outcome and maps it
to Run status `succeeded`, `cancelled` or `failed`. A failed binding contains
the exact bounded package-owned `PIPELINE_TERMINAL` fault; successful and
cancelled bindings contain no fault.

After decoding, the private seam proves a bijection between compiled terminal
pairs and bindings. Duplicate, missing, extra or mismatched bindings are
`PLAN_INVALID`.

### Logical closure versus physical settlement

Pipeline termination may select a logical Run terminal while remote work is
still executing or its physical result is unknown. `Attempt.progressionClosedAt`
is the semantic fence. Such a node becomes `retiring`, retains its active
Attempt, incarnation, fence, lease and reconciliation evidence, and remains
discoverable for cancellation/reconciliation.

A later observation can settle only the physical Attempt and move the node to
`retired`. It cannot reopen progression, change the terminal Run, activate a
successor or emit a post-terminal public Run event. The logical terminal event
remains the final public subscription event.

### One atomic Store operation

The closed Store command family gains one framework-neutral
`apply_progression_transition` operation. It carries only package-owned domain
transition, trigger, complete revision/absence expectations and idempotency
write. It contains no decoded plan, pipeline type, ORM value, transaction
callback or provider handle.

The Store atomically verifies the exact plan pin, Run/node/Attempt revisions,
active Attempt authority, incarnation/fence/lease/handoff state, scoped
activation identity, and absence of every derived immutable ID. It then
commits the whole ordered transition, progression state, nodes, Attempts,
outputs, events, activations, receipts and idempotency result, or none of them.
The abstract logical fake is proof of this contract only; it is not evidence of
PostgreSQL isolation or rollback.

### Idempotency and faults

Strict outer-shape validation precedes I/O. Stable idempotency content includes
the operation and target, plan pin, outcome/fault, resolution, progression
values and complete task outputs or gate answer output. It excludes occurrence
and allocation material, derived IDs, revisions and transaction time.

- same external key plus identical stable request replays the recorded result;
- same external key plus changed stable content is `IDEMPOTENCY_CONFLICT`;
- a new external key plus identical semantic request and host attachment is an
  unchanged, no-write replay;
- reusing a semantic identity with changed semantic content or host attachment
  is `PROGRESSION_COMMAND_CONFLICT`.

Expected private failures map to bounded package codes:
`PLAN_INVALID`, `PROGRESSION_STATE_INVALID`,
`PROGRESSION_COMMAND_CONFLICT`, `PROGRESSION_LIMIT` and
`PROGRESSION_INVARIANT`. Raw pipeline diagnostics, paths and messages never
cross or enter durable state.

### Exactly one lifecycle attempt

The private lifecycle method receives one already snapshotted exact plan
document, one package-owned command, allocation material and external
idempotency key. It normalizes before I/O and performs exactly one Store
transaction attempt:

```text
normalize request
  -> check external idempotency
  -> load complete authoritative aggregate
  -> validate authority and exact plan pin using transaction time
  -> decode, project and reduce once
  -> map the whole ordered batch
  -> validate one domain transition
  -> commit once
```

A revision or approved absence conflict rolls the complete attempt back and
returns fixed package-owned retryable `REVISION_CONFLICT`. Lifecycle performs
no reload, second decode, second reduction or retry. Stale fence/activation,
invalid state, idempotency, plan and progression faults are not classified as
revision contention.

### Deferred coordinator

RunManager retry coordination is a separately reviewed future slice. Its
accepted minimum behavior is one initial attempt plus at most three contention
retries. Every retry reloads the exact plan and complete authority, obtains new
transaction time, recomputes all projections and supplies a fresh allocation
seed; initialization also supplies a fresh occurrence key. One external
idempotency key remains stable. Cancellation is checked before each plan load
and attempt. Exhaustion returns fixed `REVISION_CONFLICT`.

This slice implements the dependency-free domain progression foundation and
abstract Store progression operation. It does not claim the private pipeline
seam, one-attempt lifecycle integration, registry dependency, or deferred
RunManager coordinator.

## Dependency and delivery gates

Delivery is sequential:

1. accepted contracts and this ADR;
2. dependency-free package-owned domain and abstract Store foundation;
3. external publication/provenance approval;
4. exact registry dependency plus private seam and one-attempt lifecycle;
5. separately reviewed RunManager coordinator.

The final dependency must be exact registry
`@revisium/revo-pipeline@0.0.0`, with lockfile integrity and clean isolated
consumer proof. Workspace, link, file, git, archive, vendored, alias and hidden
checkout dependencies are forbidden in any commit, PR, package or verification
evidence. Publication, tag and release remain explicit human gates.

## Alternatives rejected

- Infer semantics from Run rows, outputs and events: provenance, verdict,
  resolution, selector and replay facts are ambiguous.
- Persist `PipelineSnapshot`: pipeline representation would leak into the
  domain and Store boundary.
- Prescribe relational progression tables now: no concrete adapter exists and
  physical schema is adapter-owned.
- Commit executor result and progression separately: a crash can strand a Run
  and duplicate successors.
- Treat logical retirement as physical cancellation: remote outcome evidence
  would be lost.
- Put retries in the lifecycle seam: it would reuse stale authority and mix
  single-attempt atomicity with manager coordination.
- Add Prisma, SQL or DBOS: persistence implementation is outside this slice.

## Consequences

The integration stays one-way, storage-neutral and testable as pure translation
plus one abstract atomic operation. `revo-run` retains a high-level lifecycle
boundary without exposing pipeline types or requiring consumers to assemble
low-level facts. The cost is explicit package-owned semantic state and a later
real-database proof for each concrete adapter.
