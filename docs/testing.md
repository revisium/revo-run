# Testing strategy

## Current status

The architecture validator is active. The package product still ships only an
empty root entrypoint; all behavior proof below is required before Draft APIs
become implemented or Stable.

## Proof layers

### Domain and lifecycle

Tests MUST prove:

- run/node/attempt/output/event invariants;
- unique manager incarnation authority despite repeated owner labels;
- `claimed` versus `start_committed` recovery semantics;
- gate activation identity and one immutable answer;
- causal fork-scope isolation for repeated/nested activations;
- exact plan document lookup and mismatch rejection;
- JSON pipeline decoding only through private `lifecycle/pipeline/**`;
- prospective change -> scoped facts -> pipeline decision -> package intent ->
  combined validation order;
- conflict reload/recompute and scoped join uniqueness;
- pipeline-free lifecycle index and no pipeline type/cast leak through any
  public/transitive declaration.

### Manager

Deterministic manager tests MUST prove:

- complete stopped/starting/running/quiescing/draining/stopped state machine;
- recovery and incarnation allocation before normal claims;
- multi-run concurrency and starvation avoidance;
- claim -> `claimed` -> exact resolve/config verification -> fresh Start CAS ->
  `start_committed` -> dispatch;
- Start/heartbeat/direct/reconciled/cancel rejection at exact lease expiry;
- exact executor pin/configuration-digest resolution during recovery;
- expiry-or-fenced-handoff takeover before safe never-started recovery or
  conservative started reconciliation;
- no blind retry of unknown non-idempotent execution;
- cancellation races;
- heartbeats/results during drain, fenced timeout handoff committed before
  stopped, and zero writes after stop;
- `RunSubscription.initial` snapshot/cursor, iteration strictly after that
  cursor, pull backpressure, and bounded resume;
- immediate iterator completion for terminal `initial` and immediately after a
  yielded terminal item, with no extra read/wait;
- consistent initial snapshot/high-watermark with no observation gap;
- terminal wait using the same observation protocol.

### Store and real database

Every adapter conformance suite MUST cover:

- immutable snapshots and stable pagination;
- consistent snapshot plus event high watermark;
- bounded event/cursor resume;
- idempotency conflict semantics;
- plan pin plus exact executor pin/configuration digest persistence;
- transaction-time lease boundary;
- atomic state/attempt/output/event/scoped-activation commit;
- structured CAS/incarnation/fence conflicts;
- bounded eligibility/recovery scans.

Real shared-database E2E, not only an in-memory fake, MUST prove:

- competing managers create one active Attempt/incarnation/fence;
- identical owner labels do not share authority;
- exact resolution/config verification before a fresh Start CAS and no dispatch
  before `start_committed`;
- local clock skew is irrelevant;
- Start/heartbeat/all result sources reject when
  `transactionNow >= leaseExpiresAt`;
- stale incarnation/fence rejection;
- database-time-expiry or durable-fenced-handoff takeover before safe claim
  recovery versus unknown started recovery;
- exact executor resolution after deployment change;
- repeated/nested fork scopes cannot cross-satisfy joins;
- gate/cancellation/result races;
- subscription reconnect from `.initial` without snapshot/event gap and without
  replaying that initial cursor;
- terminal initial/item subscription liveness without an extra store read or
  notification wait;
- drain timeout fenced handoff-before-stopped and late callback rejection;
- rollback leaves no partial transition artifacts.

### Executor

Adapter conformance MUST prove:

- exact `resolveExact(ExecutorContractPin)` with no fallback;
- configuration digest verification;
- immutable bounded inputs;
- normalized success/failure/cancellation/unknown;
- repeated observational reconcile and repeated cancellation tolerance;
- provider failures become bounded faults;
- no store/manager/pipeline/provider type leak.

### Public declarations and packed package

Before `RunManager` ships, declaration and one-exact-tarball tests MUST prove:

- only the approved facade is public;
- internal attempt/recovery operations are absent;
- `ExecutionPlanSource` returns `RunExecutionPlanDocument`;
- `compiledPipeline` is `JsonValue`;
- executor resolution requires exact pin and digest;
- subscription exposes `.initial` snapshot/cursor and is a pull
  `AsyncIterable`, not callback push;
- the positive and intentionally leaking TypeScript declaration graphs prove
  reachable transitive pipeline-marker detection;
- lifecycle facade/manager/composition/root declarations expose no pipeline
  type, package reference, or cast;
- composition accepts store while manager source imports no
  storage/domain/pipeline, imports only the lifecycle index, and does not infer
  boundary contracts with `Parameters<>` or `ReturnType<>`;
- strict ESM/TypeScript consumers compile and deep imports fail.

### Architecture

Architecture verification MUST cover the real graph, one representative
nine-layer positive graph, exact negative rules, cleanup, and actual Oxc
failures with exact family messages for configured tooling/generated, Prisma,
MCP, orchestrator, agent-runtime, scripts, and manager pipeline restrictions.

Required exact probes include manager -> storage/domain/pipeline, manager
private-lifecycle and cross-boundary inference, lifecycle index -> private
pipeline seam, ports -> pipeline, runtime value in ports, each exact
composition -> policy/domain/pipeline edge, executor runtime, scripts, and
unknown custom layer.

## Scenario matrix

| Scenario                     | Required proof                                            |
| ---------------------------- | --------------------------------------------------------- |
| exact plan document          | pipeline remains JSON outside private lifecycle seam      |
| exact executor contract      | persisted pin/digest; recovery has no fallback            |
| claim crash before Start     | takeover gate, exact resolve, fresh Start; no side effect |
| crash after Start            | takeover gate, new incarnation/fence, then reconcile      |
| exact lease boundary         | Start/heartbeat/all results reject at equality            |
| unknown non-idempotent work  | no redispatch                                             |
| repeated/nested fork         | causal scopes cannot cross-satisfy joins                  |
| stop during execution        | drain, fenced handoff before stopped, no later writes     |
| subscription process loss    | `.initial` snapshot/cursor then strictly-later iteration  |
| terminal subscription state  | immediate completion without another read or wait         |
| terminal waiter process loss | same durable observation protocol                         |

## Coverage and release gate

Once product source exists, coverage includes `src/**` and architecture
scripts. No Draft API becomes implemented until behavior, types, declarations,
packed consumer, exports, README, specs, and architecture checks agree.
