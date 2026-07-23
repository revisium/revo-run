<div align="center">

# @revisium/revo-run

**A portable, durable, concurrency-safe run-state engine for Revo.**

[![CI](https://github.com/revisium/revo-run/actions/workflows/ci.yml/badge.svg)](https://github.com/revisium/revo-run/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=revisium_revo-run&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=revisium_revo-run)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=revisium_revo-run&metric=coverage)](https://sonarcloud.io/summary/new_code?id=revisium_revo-run)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

> [!IMPORTANT]
> This repository is in bootstrap. The npm package is not published, its root export is intentionally empty, and every API
> below is a Draft target specification rather than available code.

## About

`@revisium/revo-run` will own the authoritative mutable state and lifecycle decisions for one durable run. It coordinates
run node instances, attempts, outputs, audit events, atomic transitions, retries, leases, fencing, human gates, forks, and
joins while leaving polling and physical execution to the host.

For every lifecycle command, the host supplies the matching immutable `ExecutionPlan` and public `CompiledPipeline`. A
`Run` stores only the execution plan identity, revision, and digest as immutable pins; the package never persists or
compiles the full plan.

## Quick start

This target-only example assumes the consumer has already compiled and verified an immutable execution plan. See the
[expanded consumer example](./docs/examples/consumer.md) for failure/retry, human-gate, and worker-loop flows.

```ts
import { createRunEngine } from '@revisium/revo-run';

const runs = createRunEngine({
  store: runStore,
  clock,
  ids,
});

const hostPlan = await executionPlanRepository.getExact(request.executionPlan);

const execution = {
  plan: {
    id: hostPlan.id,
    revision: hostPlan.revision,
    digest: hostPlan.digest,
    transitionPolicy: hostPlan.transitionPolicy,
  },
  pipeline: hostPlan.compiledPipeline,
};

const created = await runs.createRun({
  execution,
  runId: crypto.randomUUID(),
  idempotencyKey: request.id,
  input: request.input,
});

const [candidate] = await runs.listClaimable({
  runId: created.runId,
  now: clock.now(),
  limit: 1,
});

if (candidate) {
  const claim = await runs.claimAttempt({
    execution,
    runId: candidate.runId,
    nodeInstanceId: candidate.nodeInstanceId,
    expected: candidate.expected,
    workerId,
    leaseUntil: clock.now().add({ minutes: 5 }),
    idempotencyKey: `${workerId}:${candidate.nodeInstanceId}`,
  });

  const result = await executeNode({
    claim,
    binding: hostPlan.executorBindings[claim.nodeKey],
  });

  await runs.completeAttempt({
    execution,
    runId: claim.runId,
    nodeInstanceId: claim.nodeInstanceId,
    attemptId: claim.attemptId,
    expected: claim.expected,
    workerId,
    fencingToken: claim.fencingToken,
    outputs: [{ name: 'result', type: 'application/json', value: result }],
    idempotencyKey: `${claim.attemptId}:complete`,
  });
}
```

- `createRun()` pins one plan identity/revision/digest and atomically creates initial node activations.
- `listClaimable()` returns candidates, not claims; `claimAttempt()` performs the authoritative CAS.
- An `Attempt` owns the live worker, lease, and fencing token. Node-level copies never authorize mutations.
- `completeAttempt()` and `failAttempt()` combine a prospective domain change with fresh pipeline facts, then atomically
  commit state, outputs, events, and successor activations.
- A retry is plan-governed durable state. The host later discovers it through `listClaimable()` when it becomes due.
- `answerHumanGate()` accepts an explicit normalized resolution plus an immutable answer output through one gate/run CAS;
  lifecycle never parses the output payload for control flow.
- Every accepted node transition CASes monotonic `Run.revision`, preserving join liveness under concurrent branch
  completions.

The host owns the worker loop, executor selection, process lifecycle, credentials, and scheduling cadence. The engine
neither polls nor executes work.

## Complete target API

This is the proposed consumer facade. Names and exact shapes remain **Draft and unimplemented**; the normative behavior is
defined by the [Draft specifications](./docs/README.md).

```ts
export declare function createRunEngine(options: RunEngineOptions): RunEngine;

export interface RunEngine {
  createRun(command: CreateRunCommand): Promise<CreateRunResult>;
  getRun(query: GetRunQuery): Promise<RunSnapshot | undefined>;
  listClaimable(query: ListClaimableQuery): Promise<readonly ClaimableNode[]>;
  listDueRetries(query: ListDueRetriesQuery): Promise<readonly RetryCandidate[]>;
  listExpiredLeases(query: ListExpiredLeasesQuery): Promise<readonly ExpiredLeaseCandidate[]>;
  getWaitingHumanGate(query: GetWaitingHumanGateQuery): Promise<WaitingHumanGate | undefined>;
  listRunOutputs(query: ListRunOutputsQuery): Promise<readonly RunOutputSnapshot[]>;
  listRunEvents(query: ListRunEventsQuery): Promise<RunEventPage>;

  claimAttempt(command: ClaimAttemptCommand): Promise<AttemptClaim>;
  startAttempt(command: StartAttemptCommand): Promise<AttemptTransition>;
  heartbeatAttempt(command: HeartbeatAttemptCommand): Promise<AttemptTransition>;
  completeAttempt(command: CompleteAttemptCommand): Promise<TransitionResult>;
  failAttempt(command: FailAttemptCommand): Promise<TransitionResult>;
  expireAttemptLease(command: ExpireAttemptLeaseCommand): Promise<TransitionResult>;
  answerHumanGate(command: AnswerHumanGateCommand): Promise<TransitionResult>;
  cancelRun(command: CancelRunCommand): Promise<TransitionResult>;
}

export interface RunExecutionInput {
  readonly plan: ExecutionPlanInput;
  readonly pipeline: CompiledPipeline;
}

export interface RunLifecycleCommand {
  readonly execution: RunExecutionInput;
  readonly runId: string;
  readonly expected: ExpectedRunState;
  readonly idempotencyKey: string;
}

export interface AttemptAuthority {
  readonly attemptId: string;
  readonly workerId: string;
  readonly fencingToken: string;
  readonly expected: ExpectedAttemptState;
}

export interface AttemptTransition {
  readonly attempt: AttemptSnapshot;
  readonly expected: ExpectedAttemptState;
}

export interface AnswerHumanGateCommand extends RunLifecycleCommand {
  readonly nodeInstanceId: string;
  readonly resolution: string;
  readonly answer: RunOutputInput;
  readonly actor: RunActor;
}
```

Every mutating command includes the narrow `RunExecutionInput` and explicit expected revisions. It never receives host
executor, profile, prompt, credential, or workspace bindings. Completion, failure, lease expiry, and gate answering may
return a conflict; on aggregate conflict the lifecycle reloads authoritative state and recomputes the prospective change
and pipeline decision before retrying.

`AnswerHumanGateCommand.resolution` is a normalized control-flow fact validated against the supplied pipeline. `answer` is
stored as an immutable output but never parsed to determine the transition.

Query ports may expose claimable nodes, due retries, and expired leases, but they never reserve work. Exact storage ports,
bounded values, faults, snapshots, event pagination, and command results remain part of the Draft specification work.

## Responsibility boundary

The package owns:

- `Run`, `RunNodeInstance`, authoritative `Attempt`, multiple immutable `RunOutput` records, and append-only audit
  `RunEvent` records;
- deterministic lifecycle decisions and aggregate invariants;
- atomic state/output/event/activation commits with CAS and idempotency;
- claim, lease, fencing-token, expiry, and retry eligibility;
- fresh-facts pipeline decisions and unique join activation;
- a waiting node instance as the human gate and an immutable output as its answer;
- transactional command and read/query ports for durable state.

The consumer owns:

- execution-plan compilation, storage, verification, and exact plan lookup for every command;
- profiles, models, prompts, permissions, agents, scripts, executors, credentials, and workspaces;
- worker polling cadence, process execution, queueing, deployment, and recovery policy;
- concrete storage adapters, database lifecycle, migrations, and operational infrastructure;
- GraphQL, MCP, CLI, HTTP, product inboxes, timelines, counters, and other projections.

There are no authoritative `Gate` or `JoinArrival` entities. Join readiness is derived from the immutable pipeline and
authoritative node instances. `RunOutput` stores durable payloads or artifact references; `RunEvent` is an audit timeline,
not current-state authority.

The core has no Prisma or DBOS dependency. A future PostgreSQL/Prisma adapter requires a separate accepted ADR and export
decision.

## Documentation

- [Run domain v1](./docs/specs/run-domain-v1.spec.md) — aggregate entities, statuses, and invariants.
- [Run transitions v1](./docs/specs/run-transitions-v1.spec.md) — command families and atomic transition semantics.
- [Execution plan input v1](./docs/specs/execution-plan-input-v1.spec.md) — immutable host-owned command seam.
- [Run storage v1](./docs/specs/run-storage-v1.spec.md) — transactional ports and concurrency proof.
- [Architecture](./docs/architecture.md) — layers, dependency direction, pipeline seam, and ownership boundaries.
- [Expanded consumer example](./docs/examples/consumer.md) — complete target host integration.
- [ADRs and documentation index](./docs/README.md) — accepted decisions and repository policies.
- [Testing](./docs/testing.md) — proof layers and required implementation coverage.
- [Release train](./docs/release-train.md) — verified package release flow.

All specifications and API examples are currently **Draft and unimplemented**.

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

The package is ESM-only, uses explicit exports, emits declarations, and ships only `dist`, `README.md`, `LICENSE`, and
package metadata. The bootstrap entrypoint stays empty until the public run-engine slice is implemented, tested, and
documented.

## License

[MIT](LICENSE) © Revisium
