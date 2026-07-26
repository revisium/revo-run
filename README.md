<div align="center">

# @revisium/revo-run

**A portable, durable RunManager for Revo.**

[![CI](https://github.com/revisium/revo-run/actions/workflows/ci.yml/badge.svg)](https://github.com/revisium/revo-run/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=revisium_revo-run&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=revisium_revo-run)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=revisium_revo-run&metric=coverage)](https://sonarcloud.io/summary/new_code?id=revisium_revo-run)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

> [!IMPORTANT]
> This repository is in bootstrap and the npm package is not published. Its root runtime namespace is intentionally empty
> and currently exports only Stable portable contract types. `@revisium/revo-run/canonical-json` is implemented; the
> package-private pure Run domain foundation and type-only Store contracts are implemented. Store behavior currently has
> logical fake conformance only, not durable-database proof. Package-private executor snapshots, pure binding verification,
> fault refinements, and type-only ports are implemented. Package-private lifecycle discovery, claim, lease renewal,
> durable handoff, ownership acquisition, and exact resolver/Start preparation are also implemented. Lifecycle now
> normalizes executor observations, prepares reconciliation under a fresh fenced CAS, records direct unknown and
> reconciled running/unknown outcomes, and prepares known terminal observations without committing their later pipeline
> progression. Retry/terminal progression, cancellation invocation, manager/composition, and the RunManager APIs below
> remain Draft target specifications.
> Architecture enforcement is active in repository validation.

## About

`@revisium/revo-run` will provide one reusable `RunManager` that owns the complete durable lifecycle of many concurrent
runs. A consumer injects storage, an exact immutable plan source, executor adapters, identifiers, and optional
process-coordination policy. The manager owns recovery, polling, claims, database-time leases and fences, heartbeats,
execution dispatch, retries, pipeline and human-gate progression, cancellation, process-local concurrency, durable
subscriptions, and graceful drain.

The host remains responsible for API transports, authorization, product projections, plan compilation and versioning,
concrete storage wiring, and executor adapters. It does not need a separate `RunWorker`.

## Implemented canonical JSON API

Import the shipped value utilities from their semantic subpath:

```ts
import {
  canonicalizeJson,
  digestCanonicalJson,
  type CanonicalJsonSha256Digest,
  type JsonValue,
} from '@revisium/revo-run/canonical-json';

const value: JsonValue = { input: ['stable', 1] };
const canonical = canonicalizeJson(value);
const digest: CanonicalJsonSha256Digest = digestCanonicalJson(value);
```

The implementation first creates a descriptor-safe snapshot without invoking
getters, setters, or `toJSON`. It rejects unsupported or hostile shapes,
cycles, non-finite numbers, and invalid Unicode. Fixed limits are depth 64,
65,536 total members, and 1 MiB of canonical UTF-8 bytes. It follows RFC 8785
and hashes exactly the returned UTF-8 text.

The root remains runtime-empty. A canonical digest is a general value digest;
it is not an execution-plan or executor-contract pin.

## Implemented portable contract types

The package root exposes provider-neutral values as type-only exports:

```ts
import type {
  ExecutionPlanPin,
  ExecutorContractPin,
  RunArtifactReference,
  RunExecutionPlanDocument,
  RunFault,
  RunOutputPayload,
} from '@revisium/revo-run';
```

They cover exact opaque plan/executor pins, JSON-only immutable plan documents,
canonical executor-configuration digests, bounded retry/timeout/lease and
process-local concurrency policy, typed faults/conflicts, and a closed
value-or-artifact output payload.

Plan digests remain opaque and host-owned. Executor configuration digests use
the shipped canonical JSON algorithm over the complete defensive configuration
snapshot. Artifact references contain only opaque id, media type, lowercase
SHA-256, and safe byte count; they contain no locator, URL, path, provider,
retention, or credential fields.

The package uses internal snapshot/validation helpers at its boundaries. Those
helpers are not package exports. Fixed v1 limits and exact shapes are defined in
[Portable run contracts v1](./docs/specs/portable-run-contracts-v1.spec.md).

## Implemented internal domain foundation

The package now contains package-private pure models and prospective reducers
for `Run`, `RunNodeInstance`, authoritative `Attempt`, immutable `RunOutput`,
and pre-persistence `RunEventIntent`. They implement exact status matrices,
active-attempt compatibility, manager-incarnation/fence/lease validation
against supplied transaction time, deterministic scoped activation keys,
aggregate revision rules, cancellation intent, and known/unknown/reconciled
result preparation.

This is intentionally not a package export or a working manager. It performs no
storage write, CAS, polling, executor call, clock read, handoff/takeover,
pipeline progression, or terminal-policy selection. Those boundaries remain
Draft and are introduced only by their owning later slices.

## Implemented internal Store contracts

The package-private type-only `storage` layer defines the closed transactional
Store commands, DB-time/CAS expectations, idempotency identities, fence-scoped
handoff history, ownership acquisition results, materialized events, discovery
candidates, and bounded cursor pages. It is not a root or package export.

The repository test harness exercises the logical contract, including atomic
rollback, transaction terminality, command families, lease/fence boundaries,
handoff consumption, takeover pairs, scoped activation uniqueness, ordered
events, and bounded pagination. This evidence does not claim database time,
isolation, locking, contention, SQL rollback, reconnect behavior, or
cross-process correctness. No PostgreSQL, SQL, Prisma, or provider adapter is
implemented.

## Implemented internal executor contracts

The package-private executor slice defines bounded immutable invocation and
output snapshots, exact binding/configuration verification with deterministic
mismatch reasons, executor-specific fault refinements, and type-only
executor/resolver ports. Missing binding idempotence defaults to `false`.

Lifecycle captures execute/reconcile capabilities only after exact resolution,
normalizes their untrusted results into bounded package-owned observations, and
uses fresh database-time authority for the implemented unknown/running
transitions. Known terminal observations stop at a frozen
`requires_progression` result because retry and graph progression require the
later pipeline slice. Adapter cancellation invocation remains unimplemented.
No manager, composition, registry, or provider adapter is implemented.

## Draft RunManager quick start

The target API is intentionally small. All names and exact shapes in this example are **Draft and unimplemented**.

```ts
import { createRunManager } from '@revisium/revo-run';

const runs = createRunManager({
  store: runStore,
  plans: executionPlanSource,
  executors: executorRegistry,
  ids: {
    nextId: () => crypto.randomUUID(),
  },
  coordination: {
    ownerLabel: processLabel,
    maxConcurrentExecutions: 8,
  },
});

await runs.start();

const run = await runs.startRun({
  plan: {
    id: request.planId,
    revision: request.planRevision,
    digest: request.planDigest,
  },
  idempotencyKey: request.id,
  input: request.input,
});

const subscription = await runs.subscribe({
  runId: run.id,
  after: request.lastSeenCursor,
});

await publishRunProjection(subscription.initial.snapshot, subscription.initial.cursor);

let cursor = subscription.initial.cursor;
let latest = subscription.initial.snapshot;

if (!latest.terminal) {
  for await (const item of subscription) {
    await publishRunProjection(item.snapshot, item.cursor);
    cursor = item.cursor;
    latest = item.snapshot;
  }
}

const terminal = latest.terminal
  ? latest
  : await runs.waitForTerminal({
      runId: run.id,
      after: cursor,
      signal: request.signal,
    });

await subscription.close();
await runs.stop({ drain: true });
```

`startRun()` persists only the exact plan pin (`id`, `revision`, and `digest`). The manager uses its injected plan source to
load that exact immutable plan for every later operation, so callers do not repeatedly supply plans and a run cannot
silently move to a newer revision.

`start()` recovers owned work and starts manager loops. `stop()` stops new claims and can drain in-flight executions.
Neither method owns the host process or network server.

## Draft public API

Names and exact shapes remain **Draft and unimplemented**; the normative behavior is defined by the
[Draft specifications](./docs/README.md).

```ts
export declare function createRunManager(options: RunManagerOptions): RunManager;

export interface RunManager {
  start(): Promise<void>;
  stop(options?: StopRunManagerOptions): Promise<void>;

  startRun(command: StartRunCommand): Promise<RunSnapshot>;
  answerGate(command: AnswerGateCommand): Promise<RunSnapshot>;
  cancelRun(command: CancelRunCommand): Promise<RunSnapshot>;

  getRun(runId: string): Promise<RunSnapshot | undefined>;
  listRuns(query?: ListRunsQuery): Promise<RunPage>;
  subscribe(query: SubscribeRunQuery): Promise<RunSubscription>;
  waitForTerminal(query: WaitForTerminalQuery): Promise<RunSnapshot>;
}

export interface RunSubscription extends AsyncIterable<RunSubscriptionItem> {
  readonly initial: {
    readonly snapshot: RunSnapshot;
    readonly cursor: RunEventCursor;
  };
  close(): Promise<void>;
}

export interface RunManagerOptions {
  readonly store: RunStore;
  readonly plans: ExecutionPlanSource;
  readonly executors: ExecutorResolver;
  readonly ids: IdSource;
  readonly clock?: LocalClock;
  readonly coordination?: RunManagerCoordination;
}
```

The plan source returns a package-owned `RunExecutionPlanDocument`.
`compiledPipeline` is bounded `JsonValue`, not a pipeline-package type. Only
private `lifecycle/pipeline/**` modules decode it with the future public
`@revisium/revo-pipeline` decoder. The public lifecycle facade is pipeline-free.
No cast or pipeline type may appear in ports, manager, composition, root
exports, or emitted declarations.

Each executor binding persists an exact `ExecutorContractPin` plus immutable
configuration digest. Recovery calls `resolveExact()`; it never resolves
latest, compatible, or default executor behavior.

The optional `clock` governs process-local waits and testability only. Durable timestamps, lease eligibility, retry
eligibility, and fencing decisions use authoritative time obtained inside the store transaction.

Claim, attempt start, heartbeat, completion, failure, lease expiry, recovery, and reconciliation are internal manager
operations. They are not host-facing lifecycle commands and are not proposed public exports.

## Execution and recovery

An executor adapter provides `execute()` and may provide `reconcile()` and `cancel()`. Claim persists an `Attempt` in
`claimed`. The manager then resolves the exact executor and verifies its immutable configuration digest. Only after that
does a separate internal Start CAS obtain fresh database time, verify the lease, and record `start_committed`; `execute()`
is invoked only after that commit. The Attempt persists the exact executor contract pin and configuration digest used for
dispatch.

Every `start()` generates a unique package-owned `managerIncarnationId`; attempts store it as ownership authority.
`ownerLabel` is diagnostic only. Direct, reconciled, cancellation, start, and heartbeat results are rejected when store
transaction time is at or beyond lease expiry.

There is no physical exactly-once execution guarantee. After a crash or lost response, an outcome may be unknown. The
manager reconciles it when the adapter supports reconciliation. It does not blindly retry unknown work unless the exact
executor binding explicitly declares execution idempotent. This prevents an apparently convenient retry from duplicating
an irreversible external action.

Retries are durable plan-governed state. Recovery may take ownership only when store transaction time is at or beyond
lease expiry, or when the incumbent recorded an explicit durable handoff under its active incarnation and fence. Process
observation and local time never authorize takeover. After takeover, `claimed` work that never committed start may be
recovered by exact executor/configuration verification followed by a fresh Start CAS. A `start_committed` attempt with
lost process ownership is conservatively unknown and requires the new incarnation/fence before reconciliation.
Process-local concurrency and `ownerLabel` are never durable ownership.

Manager lifecycle is `stopped -> starting -> running -> quiescing -> draining -> stopped`. Quiescing stops new claims while
heartbeats and fenced result commits continue. Before a drain timeout may abandon local ownership, lifecycle must record an
explicit durable handoff under the active incarnation and fence. After `stopped`, the manager performs no writes.

Query ports may expose claimable nodes, due retries, and expired leases, but they never reserve work. Exact storage ports,
bounded values, faults, snapshots, event pagination, and command results remain part of the Draft specification work.

## Responsibility boundary

The package owns:

- `Run`, `RunNodeInstance`, authoritative `Attempt`, multiple immutable `RunOutput` records, and append-only audit
  `RunEvent` records;
- atomic state, output, event, attempt, and activation changes;
- claims, database-time leases, fences, heartbeats, retry eligibility, recovery, and reconciliation;
- executor dispatch and fenced result acceptance;
- human-gate activation and answering, pipeline progression, cancellation, and terminal selection;
- process-local polling, concurrency, subscriptions, waits, and graceful drain.

The consumer owns:

- concrete store implementation, schema migrations, database operations, and transaction wiring;
- exact immutable plan compilation, persistence, and lookup by the persisted pin;
- executor adapters plus their credentials, models, prompts, permissions, scripts, agents, and workspaces;
- GraphQL, MCP, CLI, HTTP, product inboxes, timelines, counters, and other projections.

There are no authoritative `Gate` or `JoinArrival` entities. Join readiness is derived from the immutable pipeline and
authoritative node instances in the same causal fork scope. A gate answer targets a stable runtime activation id.
`RunOutput` stores durable payloads or artifact references; `RunEvent` is an audit timeline and durable subscription feed,
not current-state authority.

Core contracts contain no Prisma, NestJS, GraphQL, MCP, DBOS, queue, agent-runtime, or scripts dependency.
`@revisium/revo-pipeline` is the only planned runtime dependency and is used only by private
`lifecycle/pipeline/**` modules for pure graph progression. It is not installed until implementation needs its public API.

## Architecture

```text
spec      policy      errors
  \          |          /
            domain
               |
            storage     ports
                 \       /
                  lifecycle
                      |
                   manager
                      |
                  composition
```

`lifecycle` is the sole writable path to domain/storage. Only private `lifecycle/pipeline/**` modules import the pipeline
package; `lifecycle/index.ts` exposes explicit pipeline-free facade contracts. `manager` owns loops, imports only that
lifecycle index, and does not infer cross-boundary contracts with `Parameters<>` or `ReturnType<>`. `composition` alone
wires store, ports, lifecycle, and manager into `createRunManager`.

## Documentation

- [Canonical JSON v1](./docs/specs/canonical-json-v1.spec.md) — Stable implemented value and digest contract.
- [Portable run contracts v1](./docs/specs/portable-run-contracts-v1.spec.md) — Stable implemented pins, policies, faults,
  plan document, and output payload values.
- [RunManager v1](./docs/specs/run-manager-v1.spec.md) — public facade, recovery, subscriptions, and drain.
- [Run executor v1](./docs/specs/run-executor-v1.spec.md) — dispatch, reconciliation, cancellation, and unknown outcomes.
- [Execution plan input v1](./docs/specs/execution-plan-input-v1.spec.md) — exact immutable plan source and persisted pin.
- [Run domain v1](./docs/specs/run-domain-v1.spec.md) — durable entities, statuses, and invariants.
- [Run transitions v1](./docs/specs/run-transitions-v1.spec.md) — internal transitions and atomic semantics.
- [Run storage v1](./docs/specs/run-storage-v1.spec.md) — transactional ports, database time, leases, and CAS.
- [Architecture](./docs/architecture.md) — ownership and manager/lifecycle separation.
- [Consumer example](./docs/examples/consumer.md) — target host composition.
- [ADRs and documentation index](./docs/README.md) — accepted decisions and repository policies.
- [Testing](./docs/testing.md) — proof layers and required implementation coverage.
- [Release train](./docs/release-train.md) — verified package release flow.

The architecture and its enforcement are Accepted and active. Canonical JSON v1
and portable run contracts v1 are Stable and implemented. The internal pure
domain foundation is implemented while its product specification remains Draft.
The package-private executor contract slice is implemented, but executor
runtime behavior and every RunManager behavioral API remain **Draft and
unimplemented**.

## Requirements

- Node.js 24 (`>=24.11.1 <25`)
- pnpm 11.13.0 through Corepack
- Docker only for the local SonarCloud parity check

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

| Command                    | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `pnpm format:check`        | Verify formatting                                          |
| `pnpm typecheck`           | Check strict TypeScript without emitting                   |
| `pnpm lint`                | Run type-aware Oxlint and TypeScript diagnostics           |
| `pnpm test`                | Run every currently owned Vitest lane                      |
| `pnpm test:architecture`   | Prove allowed boundaries and representative violations     |
| `pnpm test:cov`            | Run tests with v8 coverage                                 |
| `pnpm build`               | Build ESM JavaScript and TypeScript declarations           |
| `pnpm verify:package`      | Validate the exact tarball, types, ESM, and denied imports |
| `pnpm verify:architecture` | Run the committed architecture verification harness        |
| `pnpm verify:shell`        | Parse-check committed shell scripts                        |
| `pnpm verify`              | Run the complete local CI gate                             |
| `pnpm ci:local:sonar`      | Verify, analyze with Sonar, and inspect open branch issues |

## SonarCloud

Copy `.env.sonar.example` to an ignored `.env.sonar`, provide `SONAR_TOKEN`, and run `pnpm ci:local:sonar`. Alternatively,
set `SONAR_ENV_FILE=/absolute/path/to/.env.sonar`. CI runs verification before analysis; pull requests also wait for the
Quality Gate and fail when open Sonar issues remain.

## Package contract

The package is ESM-only, uses explicit exports, emits declarations, and ships
only `dist`, `README.md`, `LICENSE`, and package metadata. The root runtime
namespace stays empty until the public `RunManager` slice is implemented,
tested, and documented. Its current type-only declarations and the canonical
JSON semantic subpath are proved from one exact tarball. Before RunManager
ships, package proof must additionally cover subscription and lifecycle
behavior and prove no pipeline type/cast leaks through any reachable public
declaration.

## License

[MIT](LICENSE) © Revisium
