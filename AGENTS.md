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
- The root runtime namespace is intentionally empty. It exports Stable portable
  contract types; the canonical JSON semantic subpath is implemented;
  the pure domain foundation is package-private and implemented; RunManager
  product specs/APIs remain Draft.
- The exact `canonicalize@3.0.0` dependency is isolated to the canonical JSON
  policy leaf. No product integration dependency is installed.

## Required reading

Before editing, inspect:

1. `README.md` for shipped package status.
2. `REPOSITORY.md` for source-of-truth order and ownership.
3. `docs/architecture.md`, the relevant ADR, and touched Draft specs.
4. `VERIFICATION.md` for exact local and remote gates.
5. `REVIEW.md` for blocking findings.
6. `package.json`, its export map, relevant source, and tests.

## Working rules

- Keep changes within the approved durable multi-run manager boundary.
- Do not commit directly to `master`.
- Do not push, create/update a PR, merge, tag, release, or publish without the
  corresponding approval.
- Run focused checks while iterating and `pnpm verify` before handoff.
- After push, inspect CI, Sonar findings, and unresolved review threads.
- Record inaccessible provider gates as skipped or blocked, never passed.

## Engineering rules

- Start behavior changes with a failing test at the owning boundary.
- Import `canonicalize` only in
  `src/policy/canonical-json/canonicalize-json.ts` and `node:crypto` only in
  `src/policy/canonical-json/digest-canonical-json.ts`.
- Keep domain decisions separate from polling, process execution, database
  frameworks, transports, and provider mechanics.
- Persist the exact immutable execution-plan pin (`id`, `revision`, `digest`) on
  `Run`. The injected plan source loads that exact plan automatically after
  `startRun`; never accept a replacement plan on later commands or snapshot the
  full plan in run storage.
- `ExecutionPlanSource` returns package-owned `RunExecutionPlanDocument`.
  `compiledPipeline` is bounded `JsonValue`; only private
  `lifecycle/pipeline/**` decodes it through the future public pipeline decoder.
  The public lifecycle index is pipeline-free. Pipeline types and casts never
  enter ports, manager, composition, root exports, or declarations.
- Keep the pipeline seam in lifecycle. Domain first validates the command's
  expected state/fence/gate revision and computes a package-owned prospective
  state/output change without committing. After loading the exact pinned plan,
  lifecycle combines authoritative sibling state with that prospective
  outcome/answer into `PipelineFacts`, calls the public pipeline decision API,
  and maps `PipelineDecision` to package-owned successor/join/wait intents.
  Domain validates the combined intent/invariants; storage then CASes expected
  Run/node/Attempt revisions and atomically commits prospective state, outputs,
  events, and activations. Pipeline imports and types never enter spec, domain,
  storage, ports, manager, composition, root, or declarations.
- Treat current run rows as authoritative mutable state. `RunEvent` is an
  append-only audit and subscription feed, not an event-sourced replacement for
  current state.
- Persist every state transition, emitted output, and audit event atomically.
- Use store-transaction time, CAS, manager incarnation, leases, monotonically
  changing fencing tokens, scoped activation keys, and idempotency keys.
  Start/heartbeat/direct/reconciled/cancel results require transaction time
  strictly before lease expiry.
- Every accepted node transition CASes monotonic `Run.revision`. On conflict,
  reload authoritative sibling state and recompute pipeline facts/decision;
  never reuse a stale join decision.
- `Attempt` is the authoritative live owner, lease, and fence record.
  `RunNodeInstance` stores status plus `activeAttemptId` and, only if required, a
  monotonic claim epoch. Create the attempt and active pointer atomically.
  Mirrored node claim fields are historical/projection data, never authority.
- Each `start()` generates a unique package-owned `managerIncarnationId`;
  attempts persist it. `ownerLabel` is diagnostic only.
- Dispatch is `claimed -> exact resolve/config verification -> fresh internal
Start CAS -> start_committed -> execute`. Recovery takeover requires
  database-time lease expiry or an explicit durable handoff written under the
  incumbent fence. It can then reclaim never-started `claimed`; lost
  `start_committed` is conservatively unknown and requires a new
  incarnation/fence plus exact resolution before reconcile.
- A human gate is a waiting `RunNodeInstance` without an `Attempt` or lease.
  Its stable runtime activation id identifies the answer target. Its answer is
  an immutable `RunOutput`; answering and resuming are one atomic CAS
  transition.
- Fork activations persist causal node-instance scope. Join readiness and
  activation uniqueness use only predecessor instances from that scope.
- Do not add authoritative `Gate` or `JoinArrival` entities.
- `RunManager` owns polling, recovery, reconciliation, dispatch, heartbeat,
  retry, cancellation, subscriptions, waits, process-local concurrency, and
  graceful drain. Do not expose claim/start/heartbeat/complete/fail/expire as
  host-facing public API.
- Manager lifecycle is `stopped -> starting -> running -> quiescing -> draining
-> stopped`. Quiescing stops claims; heartbeats/results continue during
  drain. Timeout must commit a fenced durable handoff before stopped. No manager
  write occurs after stop.
- `subscribe()` is a pull `AsyncIterable` whose `.initial` carries the
  consistent snapshot/high-watermark cursor; iteration starts strictly after
  it. Terminal `.initial` completes immediately; a terminal item is the final
  item with no later read/wait. `waitForTerminal()` uses the same protocol.
- Executor adapters provide `execute()` and may provide `reconcile()` and
  `cancel()`. Exact `ExecutorContractPin` and configuration digest are persisted
  on Attempt and verified through `resolveExact()` before each fresh Start and
  during recovery. Unknown outcomes are not blindly retried unless the exact
  binding declares execution idempotent. Never claim physical exactly-once
  execution.
- Do not implement agents, scripts, queues, HTTP, GraphQL, MCP, CLI, or host
  orchestration in core.
- Do not add Prisma, DBOS, pg-boss, Graphile Worker, Nest, GraphQL, or an
  orchestrator dependency.
- The only planned runtime dependency is `@revisium/revo-pipeline`, reachable
  only from private `src/lifecycle/pipeline/**` through public package
  contracts. `src/lifecycle/index.ts` stays pipeline-free, and manager imports
  only that index with explicit contracts, never `Parameters<>`/`ReturnType<>`
  inference. It is not installed until real lifecycle code needs it.
- Preserve strict types. Do not use `any`, `@ts-ignore`, unchecked assertions,
  or weaker public types to bypass a gate.
- Keep external payloads bounded and copied into package-owned immutable values.
- Model expected conflicts and failures explicitly; never swallow errors.
- Do not add compatibility aliases, CommonJS fallbacks, deep imports, dependency
  cycles, or speculative public entrypoints.
- Unknown `src/*` layers fail closed. Production never imports tests, scripts,
  build/coverage output, or architecture probes. Tests use only the root or
  curated layer barrels for production source.
- Enforce the exact nine-layer DAG in `REPOSITORY.md`. Lifecycle is the sole
  writable store/domain path, private lifecycle/pipeline is the sole pipeline
  importer, and composition wires store, lifecycle, and manager.

## Public package contract

- Filesystem layout is private unless declared in `package.json#exports`.
- Draft snippets are explanatory and non-executable.
- A public API ships only when source, behavior tests, type-surface tests,
  declarations, packed-consumer proof, exports, and README agree.
- Declaration and packed-consumer proof must reject pipeline types or casts in
  the lifecycle facade, ports, manager, composition, and root surfaces,
  including transitive reachable declarations.
- Runtime dependencies require an owned responsibility and dependency-DAG review.
- Publishing occurs only through the approved release workflows.

## Verification

Follow `VERIFICATION.md`. Never claim an unexecuted gate passed.
