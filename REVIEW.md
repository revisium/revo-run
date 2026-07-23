# Review Contract

Findings must cite a concrete file and line, identify the violated contract,
explain the risk, and propose the smallest sufficient correction.

## Blocking findings

Block a change when:

- shipped exports, declarations, implementation, tests, and README disagree;
- a Draft contract is presented as implemented behavior;
- host execution-plan compilation, profiles, prompts, models, workers, polling,
  agent/script execution, APIs, or provider mechanics enter the package;
- the full `ExecutionPlan` is stored by `revo-run`, is not supplied per
  lifecycle command, or its digest is not checked against `Run` pins;
- pipeline contracts leak outside lifecycle into spec, domain, or storage, or
  lifecycle bypasses the domain prospective-change -> PipelineFacts ->
  PipelineDecision -> package-intent -> combined-domain-validation seam;
- pipeline facts are built before domain validates expected
  state/fence/gate-revision preconditions, omit the prospective accepted
  outcome/answer, or storage commits any prospective change before the pipeline
  decision and combined invariant check;
- Prisma, DBOS, queue, Nest, GraphQL, MCP, CLI, orchestrator, or provider SDK
  types enter core contracts;
- current state, outputs, and audit events can commit independently;
- stale workers can complete after lease expiry or reassignment without a
  fencing-token/CAS rejection;
- a node row rather than its active `Attempt` is authoritative for live worker,
  lease, or fence state; or claim does not atomically create the Attempt and set
  `RunNodeInstance.activeAttemptId`;
- retry eligibility is confused with host polling or process scheduling;
- a gate owns an attempt/lease, accepts multiple answers, mutates an answer, or
  resumes outside the answer transaction;
- a separate authoritative Gate or JoinArrival table is introduced;
- join activation can be duplicated or is not protected by unique
  `(runId, activationKey)` semantics;
- join readiness depends on an arrival counter that can drift from plan and
  node-instance truth;
- an accepted node transition does not CAS/increment `Run.revision`, or a CAS
  conflict reuses stale sibling facts instead of reloading and recomputing the
  pipeline decision;
- `RunEvent` becomes state authority while mutable state tables still exist;
- outputs are forced into one mutable result when a node may emit multiple
  immutable named records;
- the host can bypass transition invariants through an unstructured store call;
- query ports claim work or poll implicitly rather than returning candidates;
- an execution-plan input is mutable or contains live host service objects;
- a reverse layer dependency, private cross-layer import, missing `.js` suffix,
  external dependency, or type-only cycle bypasses the package DAG;
- an unknown production layer, production-to-repository-tooling import,
  test-to-private-source import, MCP dependency, or orchestrator dependency
  bypasses fail-closed architecture rules;
- an architecture rule changes without a representative positive graph and
  exact-rule negative probe with cleanup, including a negative Oxc probe for
  lint configuration;
- production source depends on tests, scripts, generated output, or build tools;
- new code uses `any`, `@ts-ignore`, unchecked casts, silent error swallowing,
  or unbounded external values;
- a public change lacks behavior, type, declaration, packed-consumer, export,
  and documentation proof;
- lint, format, type, test, coverage, architecture, package, workflow, CI,
  Sonar, or review-thread failures are suppressed;
- release changes weaken dry-run/approval gates, immutable workflow pins, exact
  tags, package verification, or npm provenance.

## Expected evidence

- focused tests for the changed rule or behavior;
- `pnpm verify`;
- `bash -n scripts/*.sh`;
- `actionlint` when installed;
- package tarball proof from one exact packed artifact;
- after push: CI, Sonar issue-level state, and unresolved review-thread state.

Remote or credential-dependent checks must be reported as skipped/blocked with
their residual risk.
