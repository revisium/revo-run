# Verification Contract

Use Node `24.11.1` and pnpm `11.13.0`:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

`pnpm verify` runs formatting, strict type checking, type-aware lint, unit and
package tests, coverage, architecture validation, package/tarball consumer
proof, and shell syntax checks. The architecture and package checks must prove
the package has no direct or deep import/dependency on `@revisium/revo-pipeline`
or `@revisium/revo-agent-runtime`.

Focused commands are `pnpm test:unit`, `pnpm test:package`,
`pnpm verify:architecture`, and `pnpm verify:package`.

`dist/` and `coverage/` are generated and untracked. Sonar is optional locally:
without credentials it is skipped, never passed. After an approved push, inspect
the exact-head CI, Sonar issue-level state when configured, and unresolved
review threads.
