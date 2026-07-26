# Verification Contract

## Required local gate

Use Node.js 24.11.1 and pnpm 11.13.0:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

`pnpm verify` must run, in order:

1. formatting check;
2. strict TypeScript checking;
3. type-aware lint with warnings denied;
4. unit and package tests;
5. v8 coverage thresholds over production source and
   `scripts/architecture/**/*.ts`;
6. architecture validation with current graph, synthetic positive graph,
   exact-rule negative probes, positive/negative TypeScript declaration-leak
   compilation and reachable-root scanning, actual negative Oxc probes for
   every configured boundary family, and cleanup;
7. build, publint, and exact one-tarball ATTW/contents/isolated ESM/strict
   TypeScript/deep-import proof;
8. Bash syntax checks for repository shell scripts.

Generated `dist/` and `coverage/` are verification artifacts and remain untracked.

For the canonical JSON subpath, the required unit/package evidence includes RFC
8785 byte and digest fixtures, hostile descriptor/prototype/cycle/surrogate
cases, exact depth/member/UTF-8 bounds, exact dependency placement, semantic
subpath declarations, runtime use from the exact tarball, an empty root, and
deep-import denial.

## Focused commands

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:package
pnpm test:cov
pnpm verify:architecture
pnpm verify:package
bash -n scripts/*.sh
```

Run `actionlint` against `.github/workflows/*.yml` when it is installed. A
missing optional local binary is not a pass; report it as unavailable and rely
on GitHub workflow parsing plus review.

## Conditional database gate

No database adapter exists in the foundation. When one is introduced, its
verification contract must use real PostgreSQL and cover:

- competing claims with atomic Attempt creation/active-pointer assignment;
- unique manager-incarnation ownership despite reused diagnostic owner labels;
- database-transaction time authority across skewed manager clocks;
- claim -> exact resolve/config verification -> fresh Start CAS ->
  `start_committed` -> dispatch ordering;
- rejection at `transactionNow >= leaseExpiresAt` for start, heartbeat, and
  every result source;
- lease expiry and fencing rejection;
- retry availability;
- database-time-expiry or explicit durable-fenced-handoff takeover before
  manager restart recovery and unknown-outcome reconciliation;
- safe never-started claim recovery and conservative started recovery;
- exact executor contract pin/configuration digest recovery;
- no blind retry of unknown non-idempotent execution;
- repeated/nested fork races proving causal-scope join isolation;
- gate activation-id and answer CAS races;
- multiple manager processes competing safely for many runs;
- cancellation races with active executor completion;
- quiesce/drain timeout fenced handoff committed before stopped and zero writes
  afterward;
- subscription `.initial` snapshot/high-watermark consistency, iteration
  strictly after its cursor, bounded resume, and terminal wait through the same
  protocol;
- no subscription read/wait for terminal `.initial` or after a yielded terminal
  item;
- atomic state/output/event transactions.

An in-memory fake is not sufficient evidence for those properties.

The package-private lifecycle coordination suite uses the logical Store fake
only as orchestration-contract evidence. It does not satisfy this conditional
PostgreSQL gate or establish database isolation, transaction-time, or
multi-process claim behavior.

## Sonar

With `.env.sonar` or exported credentials:

```bash
pnpm ci:local:sonar
```

Without credentials, do not claim Sonar passed. After push, inspect the actual
quality gate and open issue list.

## Remote handoff gate

After an approved push:

- required GitHub checks are green for the exact head;
- Sonar quality gate and open issues are clear when configured;
- review bots and humans have no unresolved valid threads;
- the diff contains no generated `dist`, `coverage`, tarballs, credentials, or
  architecture probes.

Publication, tags, release-train write mode, and merge each require separate
approval.
