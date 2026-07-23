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
   exact-rule negative probes, negative Oxc configuration proof, and cleanup;
7. build, publint, and exact one-tarball ATTW/contents/isolated ESM/strict
   TypeScript/deep-import proof;
8. Bash syntax checks for repository shell scripts.

Generated `dist/` and `coverage/` are verification artifacts and remain untracked.

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
- lease expiry and fencing rejection;
- retry availability;
- fork/join races proving aggregate-revision recomputation and unique activation;
- gate answer CAS races;
- atomic state/output/event transactions.

An in-memory fake is not sufficient evidence for those properties.

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
