# Run Transitions v1

- Status: Draft
- Implementation: none
- Public export: none

## Transition result

For each command, lifecycle verifies the host-supplied immutable plan against
`Run` pins and loads the authoritative aggregate. Domain first validates
expected state/fence/gate-revision preconditions and computes a package-owned
prospective state/output change without committing. Lifecycle then:

1. combines authoritative sibling state with the prospective accepted
   outcome/answer into `PipelineFacts`;
2. calls the public pipeline decision API;
3. maps `PipelineDecision` into package-owned successor/join/wait intents;
4. asks domain to validate the combined intent and aggregate invariants.

The validated combined intent describes:

- expected Run/node/Attempt or gate revisions and preconditions;
- prospective state mutations and outputs;
- audit events to append;
- successor/join/wait activations to insert;
- conflict or terminal result.

Storage applies that data through one transaction, CASing all expected
Run/node/Attempt revisions before atomically committing prospective state,
outputs, events, and activations. Every accepted node transition increments
monotonic `Run.revision`. A CAS conflict invalidates both prospective and
combined intent: lifecycle reloads current aggregate/siblings and recomputes
from the first domain validation onward.

## Required transition families

### Create run

Persist the host plan identity/revision/digest pins, create the run, and
activate initial node instances in one transaction. The full plan is not stored.
Repeating the same idempotency key returns the same logical result; conflicting
input fails.

### Claim executable node

CAS `Run.revision` and the node from `ready` or due `retry_scheduled` to
`claimed`; atomically create the next authoritative `Attempt`, assign its owner,
lease expiry and fencing token, set `RunNodeInstance.activeAttemptId`, and append
a claim event. Candidate queries do not claim by themselves.

### Start and heartbeat

Only the active Attempt's matching live owner/fence may start or extend its
bounded lease. Stale, inactive, expired, or terminal attempts cannot heartbeat.

### Complete

Domain validates the expected Run/node/active-Attempt revisions, owner/fence,
lease, and nonterminal state, then computes prospective Attempt/node success and
immutable outputs without commit. Lifecycle builds `PipelineFacts` from
authoritative siblings plus that prospective success/output, calls the pipeline
decision API, and maps successors/joins/waits. Domain validates the combined
intent. Storage CASes the expected Run/node/Attempt revisions and atomically
commits prospective success, outputs, events, and activations. A stale
completion conflicts and appends no success output.

### Fail and retry

Domain validates expected Run/node/active-Attempt revisions and fence, normalizes
failure, and computes without commit one prospective outcome:

- retry scheduled with bounded `availableAt`; or
- node terminally failed for plan-defined failure transitions.

Lifecycle includes that prospective retry/failure in `PipelineFacts`, calls the
pipeline decision API, maps successor/join/wait intents, and asks domain to
validate the combined result. Storage CASes expected Run/node/Attempt revisions
and atomically commits failure/retry state, outputs, events, and any activations.
The plan owns retry limits/policy data. The package computes eligibility. The
host owns polling and physical execution.

### Expire lease

An expired active-Attempt lease invalidates its fence. Recovery may schedule
retry or terminal failure according to policy from the matching host-supplied
plan. The old worker can no longer complete.

### Answer human gate

Domain validates expected Run/gate revisions, waiting status, absence of an
Attempt/lease, and answer idempotency, then computes prospective gate completion
plus one immutable answer output without commit. Lifecycle builds
`PipelineFacts` from authoritative siblings plus the prospective accepted
answer, calls the decision API, and maps successor/join/wait intents. Domain
validates the combined intent. Storage CASes expected Run/gate revisions and
atomically commits completion, answer output, events, and activations.
Concurrent later answers conflict and append nothing.

### Fork and join

Fork creates deterministic branch activations. Join readiness is computed from
the supplied matching `CompiledPipeline` and fresh authoritative predecessor
instances. If concurrent final branch completions start from the same
`Run.revision`, one commits and the other conflicts, reloads the first result,
and recomputes; therefore the ready join is eventually observed. Join insertion
uses unique `(runId, activationKey)` in the same transaction to prevent
duplicates. No `JoinArrival` record or counter participates.

### Cancel

Record cancellation intent, prevent new claims, cancel eligible nonterminal
nodes, and finalize when plan/domain rules permit. Host process termination is
outside this package.

## Terminal rules

Terminal run and node states are immutable. Every transition table must define
allowed source statuses, expected revisions/fences, resulting statuses,
outputs/events, activation behavior, and idempotent replay behavior before the
spec becomes Stable.
