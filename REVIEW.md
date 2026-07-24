# Review Contract

Findings must cite a concrete file and line, identify the violated contract,
explain the risk, and propose the smallest sufficient correction.

## Blocking findings

Block a change when:

- shipped exports, declarations, implementation, tests, and README disagree;
- a Draft product contract is presented as implemented behavior;
- the package requires a host `RunWorker` or exposes low-level attempt commands;
- full plans are persisted or later commands can replace the plan pin;
- `ExecutionPlanSource` returns pipeline-owned types rather than package-owned
  `RunExecutionPlanDocument` with bounded `JsonValue`;
- pipeline types or casts leak into ports, manager, composition, root, or
  emitted declarations;
- compiled-pipeline JSON is decoded outside private
  `lifecycle/pipeline/**`, the public lifecycle facade references pipeline, or
  decoding does not use the future public pipeline decoder;
- executor binding/recovery lacks exact `ExecutorContractPin`, immutable
  configuration digest, or `resolveExact()` with no fallback;
- profiles, prompts, models, agents, scripts, workspaces, credentials, API/auth,
  or projections enter core ownership;
- Prisma, NestJS, GraphQL, MCP, DBOS, queue, orchestrator, agent-runtime, or
  scripts types enter production contracts;
- any dependency violates the exact nine-layer DAG in `REPOSITORY.md`;
- manager imports storage, domain, pipeline, a private lifecycle leaf, or
  infers lifecycle contracts through `Parameters<>`/`ReturnType<>`;
- ports import domain, storage, lifecycle, manager, composition, or pipeline;
- composition imports policy/domain/pipeline, lifecycle is not the sole
  writable storage/domain path, or private lifecycle/pipeline is not the sole
  pipeline importer;
- ownership uses a reusable configured label instead of a unique
  package-generated manager incarnation persisted on Attempt;
- exact executor resolution/configuration verification does not precede a fresh
  Start CAS, or claim dispatches without durable `start_committed`;
- Start, heartbeat, lease renewal, direct/reconciled/cancel result accepts at
  transaction time greater than or equal to lease expiry;
- caller/local time authorizes durable behavior;
- recovery takes over before database-time lease expiry without an explicit
  durable handoff under the incumbent fence, or executes a lost
  `start_committed` attempt before acquiring a new incarnation/fence and
  reconciling unknown outcome;
- a never-started `claimed` attempt cannot be safely distinguished/recovered;
- state, attempts, outputs, events, and scoped activations can commit
  independently;
- stale incarnation/fence can heartbeat or accept a result;
- unknown execution is blindly retried without exact binding idempotency;
- physical exactly-once execution is promised;
- cancellation or shutdown accepts unfenced results;
- manager shutdown omits quiescing/draining, stops heartbeats/results too early,
  reaches stopped before durable fenced handoff on timeout, or writes after
  stopped;
- a gate lacks runtime activation identity, accepts multiple answers, or resumes
  outside the answer transaction;
- authoritative `Gate` or `JoinArrival` state is introduced;
- fork/join readiness ignores causal node-instance scope;
- scoped successor/join activation is not unique;
- `RunEvent` becomes current-state authority;
- subscription uses push callbacks, lacks `.initial` consistent
  snapshot/high-watermark, yields at or before `initial.cursor`, lacks
  cursor/backpressure/bounds, polls or waits after a terminal initial/item, or
  wait uses a weaker protocol;
- process-local coordination becomes durable correctness authority;
- reverse/private imports, missing `.js`, external dependencies, cycles, or
  unknown layers bypass fail-closed validation;
- an architecture change lacks representative positive graph, exact negative
  probes, positive/negative reachable declaration leak proof, or actual Oxc
  negative probes with expected family messages for every configured
  restriction;
- production imports tests/scripts/generated output/probes;
- code uses `any`, `@ts-ignore`, unchecked casts, or silent error swallowing;
- public changes lack behavior/type/declaration/packed/export/docs proof;
- release or quality gates are suppressed or weakened.

## Expected evidence

- focused tests for every changed architecture rule;
- `pnpm verify`;
- `bash -n scripts/*.sh`;
- `actionlint` when installed;
- exact one-tarball package and declaration proof;
- after approved push: CI, issue-level Sonar, and review threads.

Remote or credential-dependent checks must be reported as skipped or blocked.
