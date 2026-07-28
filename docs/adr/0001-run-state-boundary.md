# ADR 0001: Durable run-state package boundary

- Status: Superseded
- Superseded by: [ADR 0002](0002-run-manager-boundary.md)
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

Every accepted node transition CASes monotonic `Run.revision`. Unique scoped
activation identity separately prevents duplicate join activation; no
JoinArrival exists.

ADR 0003 supersedes this ADR's original facts/decision integration sketch. The
host supplies an exact package-owned plan document containing bounded compiled
JSON. Lifecycle is the sole pipeline seam: its private subtree decodes once,
reduces package-owned progression state plus one command once, and maps the
whole ordered effect batch to one package-owned atomic transition. Lifecycle
performs one transaction attempt; a future manager reloads and fully
recomputes after retryable contention. Pipeline types do not enter spec,
domain, Store, ports, the public lifecycle facade, manager, composition or
root.

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
