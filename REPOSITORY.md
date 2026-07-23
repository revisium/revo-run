# Repository Contract

This repository owns the reusable durable run-state boundary for Revo. It is a
library package, not an orchestrator service, worker daemon, workflow authoring
system, execution runtime, database framework, or API server.

## Source of truth

Use this order when sources disagree:

1. Implemented source, tests, and `package.json#exports` describe shipped behavior.
2. Accepted ADRs define architecture decisions.
3. Stable specs define implemented contracts.
4. Draft specs define target behavior only and remain marked unimplemented until
   source, tests, declarations, exports, and README implement them together.
5. `docs/architecture.md` explains the target dependency direction.
6. `README.md` summarizes consumer-visible status without claiming Draft behavior.

The current root export is intentionally empty. No run API or adapter is shipped.

## Ownership

The target package owns:

- authoritative mutable `Run` and `RunNodeInstance` state;
- executable-node `Attempt` records as authoritative live owner/lease/fence state;
- multiple immutable named/typed `RunOutput` records;
- ordered append-only audit `RunEvent` records;
- transition validation and terminal-state rules;
- atomic state/output/event commits;
- claim, lease, fencing, expiry, and retry eligibility;
- gate waiting, immutable answer recording, CAS resume;
- fork activation and unique join activation;
- store/query ports for commands and eligible-work discovery.

The host owns:

- pipeline/profile/playbook persistence and versioning;
- host-specific immutable `ExecutionPlan` compilation;
- verified immutable `ExecutionPlan`/`CompiledPipeline` loading and supply on
  every lifecycle command;
- model, prompt, permission, agent, script, workspace, and credential selection;
- polling cadence, worker loops, process supervision, and task execution;
- API transports, auth, product projections, and presentation;
- concrete database wiring, migrations, operations, and deployment.

`@revisium/revo-pipeline` owns portable pipeline graph contracts, graph
validation, and pure next-transition calculation. `@revisium/revo-agent-runtime`
owns one bounded agent invocation. `@revisium/revo-scripts` owns bounded
deterministic system operations.

## Dependency direction

```text
playbooks + profiles + pipeline versions
                  |
                  v
       host ExecutionPlan compiler/store
                  |
                  | verified plan per command
                  v
          @revisium/revo-run
 authoritative state + transitions + store ports
          |                       ^
          v                       |
 host RunWorker -------- executes node work
          |
          +--> @revisium/revo-agent-runtime
          +--> @revisium/revo-scripts
```

Inside `revo-run`:

```text
spec        policy        errors
  \           |           /
             domain
                |
             storage  (type-only ports)
                \       /
               lifecycle
```

`spec`, `errors`, and `storage` are strictly type-only. Cross-layer imports use
the target layer's explicit barrel. `domain` never depends on storage or
lifecycle. `lifecycle` is the only layer allowed to import the public
`@revisium/revo-pipeline` package. Production source imports no other external
package.

Lifecycle is the anti-corruption seam. It verifies the supplied host plan
identity/digest against pins stored on `Run` and passes the command plus
authoritative aggregate to domain. Domain validates expected
state/fence/gate-revision preconditions and computes a package-owned prospective
state/output change without committing. Lifecycle combines authoritative
sibling state with that prospective outcome/answer into pipeline-owned
`PipelineFacts`, invokes the public pipeline decision API, and maps
`PipelineDecision` to package-owned successor/join/wait intents. Domain validates
the combined intent and aggregate invariants; storage atomically CASes expected
Run/node/Attempt revisions and commits prospective state, outputs, events, and
activations. Pipeline types do not enter spec or domain. The full host plan is
never snapshotted by `revo-run`.

## Storage authority

Current state tables are authoritative. Events provide audit, observability,
and projection inputs; replaying them is not required to recover current state.
Every accepted command runs in one store transaction that:

1. verifies the plan pins and the domain-validated combined intent;
2. CASes expected `Run.revision`, node revision, and active Attempt
   revision/fence or gate revision as applicable;
3. increments monotonic `Run.revision` for every node transition;
4. applies prospective state and Attempt/active-pointer relationships;
5. appends prospective outputs and ordered audit events;
6. activates package-owned successor/join/wait intents exactly once.

Creating a claim atomically inserts its Attempt and sets
`RunNodeInstance.activeAttemptId`. Node-level mirrored lease/fence fields, if a
read projection later needs them, are explicitly non-authoritative.

If the `Run.revision` CAS conflicts, lifecycle reloads current state, reconstructs
its prospective domain change, reconstructs fresh sibling facts including that
prospective outcome, and recomputes the pipeline decision/combined intent before
retrying. This liveness rule ensures one of two concurrent final branch
completions observes the other and can activate the join. Unique
`(runId, activationKey)` separately prevents duplicate activation; no
`JoinArrival` state is needed.

The storage contract is framework-neutral. A future official Prisma adapter and
PostgreSQL E2E suite require their own accepted design; Prisma types never leak
into the core API.

## Public surface

Public entrypoints exist only in the export map. The foundation exposes an empty
root. Proposed future root, adapter, and testing surfaces are not reserved by
directories or Draft documents.
