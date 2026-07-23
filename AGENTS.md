# Revo Run Repository

This is the repository-local contract for coding agents. When checked out
inside the Revisium workspace, the workspace playbook also applies. This file
wins for concrete commands, package boundaries, and repository policy.

## Repository facts

- Package: `@revisium/revo-run`.
- Package manager: pnpm 11.13.0 through Corepack.
- Runtime: Node.js `>=24.11.1 <25`.
- Language: strict TypeScript 7, ESM, NodeNext module resolution.
- Protected base branch: `master`.
- Primary local gate: `pnpm verify`.
- The root export is intentionally empty. Every spec is Draft and unimplemented.
- There are no production dependencies in the foundation.

## Required reading

Before editing, inspect:

1. `README.md` for shipped package status.
2. `REPOSITORY.md` for source-of-truth order and ownership.
3. `docs/architecture.md`, the relevant ADR, and touched Draft specs.
4. `VERIFICATION.md` for exact local and remote gates.
5. `REVIEW.md` for blocking findings.
6. `package.json`, its export map, relevant source, and tests.

## Working rules

- Keep changes within the approved run-state package boundary.
- Do not commit directly to `master`.
- Do not push, create/update a PR, merge, tag, release, or publish without the
  corresponding approval.
- Run focused checks while iterating and `pnpm verify` before handoff.
- After push, inspect CI, Sonar findings, and unresolved review threads.
- Record inaccessible provider gates as skipped or blocked, never passed.

## Engineering rules

- Start behavior changes with a failing test at the owning boundary.
- Keep domain decisions separate from polling, process execution, database
  frameworks, transports, and provider mechanics.
- Treat `ExecutionPlan` as host-owned immutable input supplied for every
  lifecycle command. Verify its identity/digest against pins stored on `Run`;
  never snapshot the full plan in run storage. This package never compiles host
  profiles, prompts, models, permissions, or executors into a plan.
- Keep the pipeline seam in lifecycle. Domain first validates the command's
  expected state/fence/gate revision and computes a package-owned prospective
  state/output change without committing. Lifecycle combines authoritative
  sibling state with that prospective outcome/answer into `PipelineFacts`,
  calls the public pipeline decision API, and maps `PipelineDecision` to
  package-owned successor/join/wait intents. Domain validates the combined
  intent/invariants; storage then CASes expected Run/node/Attempt revisions and
  atomically commits prospective state, outputs, events, and activations.
  Pipeline imports and types never enter spec or domain.
- Treat current run rows as authoritative mutable state. `RunEvent` is an
  append-only audit timeline, not an event-sourced replacement for current state.
- Persist every state transition, emitted output, and audit event atomically.
- Use CAS, leases, monotonically changing fencing tokens, and idempotency keys
  at every concurrency boundary.
- Every accepted node transition CASes monotonic `Run.revision`. On conflict,
  reload authoritative sibling state and recompute pipeline facts/decision;
  never reuse a stale join decision.
- `Attempt` is the authoritative live owner, lease, and fence record.
  `RunNodeInstance` stores status plus `activeAttemptId` and, only if required, a
  monotonic claim epoch. Create the attempt and active pointer atomically.
  Mirrored node claim fields are historical/projection data, never authority.
- A human gate is a waiting `RunNodeInstance` without an `Attempt` or lease.
  Its answer is an immutable `RunOutput`; answering and resuming are one atomic
  CAS transition.
- Join readiness is derived from the immutable plan and node instances. Create
  a join activation at most once with unique `(runId, activationKey)`.
- Do not add authoritative `Gate` or `JoinArrival` entities.
- Store/query ports may expose claimable nodes, due retries, and expired leases.
  They must not poll, sleep, schedule processes, or own a worker loop.
- Do not execute agents, scripts, queues, HTTP, GraphQL, MCP, CLI, or host
  orchestration in this package.
- Do not add Prisma, DBOS, pg-boss, Graphile Worker, Nest, GraphQL, or an
  orchestrator dependency.
- The only planned runtime dependency is `@revisium/revo-pipeline`, reachable
  only from `src/lifecycle` through public package contracts. It is not installed
  until real lifecycle code needs it.
- Preserve strict types. Do not use `any`, `@ts-ignore`, unchecked assertions,
  or weaker public types to bypass a gate.
- Keep external payloads bounded and copied into package-owned immutable values.
- Model expected conflicts and failures explicitly; never swallow errors.
- Do not add compatibility aliases, CommonJS fallbacks, deep imports, dependency
  cycles, or speculative public entrypoints.
- Unknown `src/*` layers fail closed. Production never imports tests, scripts,
  build/coverage output, or architecture probes. Tests use only the root or
  curated layer barrels for production source.

## Public package contract

- Filesystem layout is private unless declared in `package.json#exports`.
- Draft snippets are explanatory and non-executable.
- A public API ships only when source, behavior tests, type-surface tests,
  declarations, packed-consumer proof, exports, and README agree.
- Runtime dependencies require an owned responsibility and dependency-DAG review.
- Publishing occurs only through the approved release workflows.

## Verification

Follow `VERIFICATION.md`. Never claim an unexecuted gate passed.
