# revo-run

`@revisium/revo-run` is the planned reusable durable run-state engine for Revo.

The package will own the authoritative mutable state of a run: node instances,
attempts, outputs, audit events, transitions, leases, fencing, and retry
eligibility. For each lifecycle command, the host will supply its verified
immutable `ExecutionPlan` and `CompiledPipeline`; the package stores only their
identity/digest pins on `Run`. Storage/query ports let the host poll and execute
eligible work.

## Current status

This repository is a package foundation. The shipped root export is
intentionally empty. Documents under `docs/specs/` are **Draft** target
contracts, not implemented API.

The foundation deliberately contains:

- strict ESM/TypeScript package and verification tooling;
- package, architecture, coverage, and isolated-consumer proof;
- CI, Sonar, release validation, release-train, and npm-publish workflows;
- architecture decisions and Draft specifications.

It does not yet contain the run implementation, a database adapter, Prisma,
workers, API transports, or agent/script execution.

## Target boundary

The package target owns:

- `Run`, `RunNodeInstance`, `Attempt`, multiple named `RunOutput` records, and
  append-only audit `RunEvent` records;
- atomic state transitions that persist state, outputs, and events together;
- claim, lease, fencing-token, expiry, and retry decisions;
- `Attempt` as the authoritative live worker/lease/fence record, with
  `RunNodeInstance.activeAttemptId` changed in the same claim transaction;
- a human gate represented as a waiting node instance with no attempt or lease;
- immutable gate answers represented as outputs and applied with atomic CAS;
- atomic join activation keyed uniquely by `(runId, activationKey)`;
- monotonic `Run.revision` CAS and fresh-facts recomputation so concurrent final
  branch completions cannot leave a ready join undiscovered;
- store/query ports for claimable nodes, due retries, and expired leases.

The package does not own polling, worker loops, agent or script execution,
profile/model/prompt selection, host execution-plan compilation, public APIs,
or provider infrastructure.

There are no separate authoritative `Gate` or `JoinArrival` entities. Gate and
join state are represented by node instances and derived from the host-supplied
immutable plan plus authoritative run state.

## Intended dependency

The only planned production dependency is `@revisium/revo-pipeline`, and only
the lifecycle layer may depend on its public contracts. It is documented but
not installed in this foundation.

## Development

Prerequisites:

- Node.js `>=24.11.1 <25`;
- Corepack;
- pnpm `11.13.0`.

```bash
corepack enable
pnpm install
pnpm verify
```

Useful focused commands:

```bash
pnpm typecheck
pnpm test
pnpm test:architecture
pnpm verify:package
```

See [the documentation index](docs/README.md), [architecture](docs/architecture.md),
[testing](docs/testing.md), and [release train](docs/release-train.md).

## License

MIT
