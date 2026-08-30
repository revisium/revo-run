# Verification Contract

Before review, run the complete clean-registry gate:

```bash
corepack pnpm db:test:up
corepack pnpm verify
corepack pnpm db:test:down
```

The disposable PostgreSQL instance in `.env.test` is required for DBOS workflow,
event-lane, interaction, and recovery tests. The listed checks cover formatting,
strict types, type-aware lint, build output, test coverage, and shell/package
surface scans.

RN1 has exactly three pinned Revisium runtime dependencies: agent-runtime,
pipeline, and scripts. They are exact registry versions. A clean install and the
package consumer gate must not use
`file:`, `link:`, workspace, Git, URL, or temporary tarball dependencies.

Every change to the host must keep the readiness preflight, keyed live-relay
preflight, raw admission, interaction, public-schema, and fresh-process recovery
evidence applicable. Run `git diff --check` after verification.

Codex changes must execute every golden and all 19 context vectors by stable ID
through production code or the package verifier, strictly compare normalized
observations, validate the governing SHA-256 manifest under `docs/conformance/`,
and keep the fresh-process active-identity reap/no-replay proof green. Operational
route gates and source-backed exclusions are separate evidence classes, not
pseudo-vectors. Terminal URL checks include equal-byte ambiguous-wrapper work and
near-limit valid/malformed completion evidence. Live Codex/provider calls are
manual and excluded from `verify`.

For workflow changes, run `actionlint` when it is available. Pull-request CI
waits for the Sonar Quality Gate, verifies that the analysis belongs to the exact
PR head, and rejects every open issue. On `master` and `release/**` pushes, CI
uploads analysis without scanner-side waiting or branch issue API polling. The
provider-owned `SonarCloud Code Analysis` check must exist and pass on the exact
branch SHA before merge, tagging, or publication; a missing, pending, failed, or
mismatched-SHA provider check blocks the operation.
