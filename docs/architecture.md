# Architecture

## Status

The repository currently ships only an empty ESM entrypoint and verification
foundation. The run engine described here is the accepted target boundary, not
implemented API.

## Purpose

`revo-run` receives a host-owned, verified immutable `ExecutionPlan` and
`CompiledPipeline` with each lifecycle command and produces one durable,
concurrency-safe run-state transition. `Run` stores only plan
identity/revision/digest pins; the package never snapshots the full plan. The
central state machine keeps GraphQL, MCP, CLI, and workers from implementing
different transition rules.

The package is durable because its contracts make the database transaction,
CAS, lease, fence, retry, and idempotency requirements explicit. It does not
become a daemon: the host decides when to poll and execute work.

## Core model

```text
Run
├── RunNodeInstance*
│   ├── Attempt*
│   └── RunOutput*
└── RunEvent*
```

- `Run` owns overall lifecycle and immutable plan identity.
- `RunNodeInstance` is one runtime activation of a logical plan node, including
  fork branches, joins, and human gates. It stores status and an
  `activeAttemptId`, not authoritative live lease/fence data.
- `Attempt` records one executable-node claim/execution lifecycle and is the
  authoritative live worker owner, lease, and fencing-token record.
- `RunOutput` stores multiple immutable named/typed results or artifacts.
- `RunEvent` stores the ordered append-only audit timeline.

No separate Gate or JoinArrival entity is authoritative.

## Lifecycle seam and command path

```text
host supplies verified immutable ExecutionPlan + CompiledPipeline + command
    |
    v
lifecycle verifies plan digest against Run pins
    |
    v
domain validates expected state/fence/gate revision
and computes package-owned prospective state/output change (no commit)
    |
    v
lifecycle maps authoritative siblings + prospective outcome/answer
-> pipeline-owned PipelineFacts
    |
    v
public revo-pipeline decision API
    |
    v
lifecycle maps PipelineDecision
-> package-owned successor/join/wait intents
    |
    v
domain validates combined intent + run/node/attempt invariants
    |
    v
store transaction CASes expected Run/node/Attempt revisions
and commits prospective state + outputs + events + activations
    |
    +-- success
    |
    `-- revision conflict -> reload state/siblings and recompute from fresh facts
```

Only lifecycle imports pipeline contracts. `PipelineFacts`, `CompiledPipeline`,
and `PipelineDecision` never enter spec, domain, errors, or storage. Domain owns
both the prospective change and final combined invariant checks; neither phase
commits.

Read/query ports expose work candidates. The host RunWorker polls candidates,
claims through a command/CAS port, invokes an executor, and reports completion.
The package neither sleeps nor executes work.

Claim atomically creates the Attempt and sets
`RunNodeInstance.activeAttemptId`. Any copied node-level owner/lease/fence
fields are historical or projection data and cannot authorize heartbeat,
completion, retry, or recovery. Gates have no Attempt or active pointer.

## Fork, join, consensus, and gates

- Fork activation creates branch node instances with deterministic activation
  keys in the same transition.
- Join readiness is derived from the compiled graph and current predecessor
  node instances. Every accepted node transition CASes and increments monotonic
  `Run.revision`. When concurrent branch transitions conflict, the loser reloads
  authoritative sibling state, recomputes its domain prospective outcome, then
  pipeline facts/decision and combined intent; therefore one of two final
  completions observes the other and activates the ready join.
  Unique `(runId, activationKey)` separately prevents duplicate join activation.
- Consensus is a pipeline-defined transition/execution pattern. The run engine
  stores each branch attempt and output and applies the resulting transition;
  it does not select models or implement agent consensus itself.
- A human gate is a waiting node instance without an attempt or lease. Its
  answer is an immutable output. CAS answer acceptance, gate completion, audit
  event, and successor activation are one transaction.

## State authority and projections

Mutable run and node rows answer current-state queries. Events are durable audit
and projection inputs, but run recovery does not require event replay. Product
inboxes, timelines, counters, and dashboards are projections that can be
rebuilt from authoritative state and events.

The Attempt referenced by `activeAttemptId` is the sole live claim authority.
`Run.revision` is the aggregate serialization point for node transitions; node
and Attempt revisions/fences remain narrower preconditions, not substitutes for
the aggregate CAS.

## Package layers

| Layer       | Responsibility                                             | May depend on                     |
| ----------- | ---------------------------------------------------------- | --------------------------------- |
| `spec`      | portable immutable input/value contracts                   | same layer                        |
| `policy`    | pure limits and deterministic policy helpers               | `spec`                            |
| `errors`    | type-only conflict/fault contracts                         | `spec`                            |
| `domain`    | pure state and transition decisions                        | `spec`, `policy`, `errors`        |
| `storage`   | type-only transactional command/query ports                | `spec`, `errors`, `domain`        |
| `lifecycle` | use cases coordinating domain decisions and store commands | all prior layers, `revo-pipeline` |

Cross-layer imports use explicit layer barrels. `spec`, `errors`, and `storage`
contain type syntax only. The architecture harness enforces the graph even
before those source directories exist. Unknown production layers fail closed;
production cannot import repository tooling, and tests can import production
only through the root or curated layer barrels.

## External boundaries

The only planned production dependency is `@revisium/revo-pipeline`, imported
only by lifecycle. MCP and orchestrator packages are explicitly forbidden
dependencies. Concrete PostgreSQL/Prisma adapters may later be package
subpaths, but cannot make Prisma a core contract. Their design and export
surface require a separate accepted ADR.

Excluded responsibilities include DBOS, queues, worker loops, agent/script
execution, profiles, host plan compilation, Nest, GraphQL, MCP, and CLI.
