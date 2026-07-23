# ADR 0001: Durable run-state package boundary

- Status: Accepted
- Date: 2026-07-23

## Context

The orchestrator previously mixed pipeline traversal, durable state, worker
mechanics, database access, gates, outputs, events, and agent execution. That
made transition rules host-specific and difficult to test independently.

We need one reusable package with strong concurrency semantics without creating
a second orchestration service or embedding a durable workflow framework.

## Decision

Create `@revisium/revo-run` as a library that owns authoritative mutable run
state, pure transition decisions, and framework-neutral transactional
store/query ports.

The model is `Run`, `RunNodeInstance`, `Attempt`, multiple immutable
`RunOutput`, and append-only audit `RunEvent`. A gate is a waiting node instance;
a join is a uniquely activated node instance. There are no authoritative Gate
or JoinArrival entities.

State updates, outputs, events, and successor activations commit atomically.
`Attempt` is the authoritative live worker/lease/fence record; claim creates it
and updates `RunNodeInstance.activeAttemptId` atomically. Gates have no Attempt
and resume by CAS.

Every accepted node transition CASes monotonic `Run.revision`. A conflict
reloads sibling state and recomputes the domain prospective change, pipeline
facts/decision, and combined intent, providing join liveness. Unique
`(runId, activationKey)` separately prevents duplicate join activation; no
JoinArrival exists.

The host supplies its verified immutable execution plan and `CompiledPipeline`
with every lifecycle command. `Run` stores only plan identity/digest pins.
Lifecycle is the only pipeline seam. Domain first validates expected
state/fence/gate revision and computes a package-owned prospective state/output
change without commit. Lifecycle builds `PipelineFacts` from authoritative
siblings plus the prospective outcome/answer, calls the public pipeline API,
and maps `PipelineDecision` to package-owned successor/join/wait intents. Domain
validates the combined intent/invariants; storage CASes expected
Run/node/Attempt revisions and atomically commits prospective state, outputs,
events, and activations. Pipeline types do not enter spec or domain.

The host polls eligible work, executes tasks, and owns every API and
infrastructure adapter. `@revisium/revo-pipeline` is the only planned production
dependency and is reachable only from lifecycle.

## Consequences

- GraphQL, MCP, CLI, and workers share one transition engine.
- Current state remains cheap to query; events provide audit without requiring
  event-sourced recovery.
- PostgreSQL concurrency can be tested behind ports without leaking Prisma.
- The package is not independently deployable and needs no daemon or queue.
- Host plan compilation and product projections remain in the orchestrator.
- A future Prisma adapter needs an explicit ADR, E2E proof, and export decision.
