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
surface scans. The package gate performs one lifecycle pack before typechecking
the root consumer fixture. Publint, attw, and the consumer use that same tarball;
source scans inspect source, and packed test-hook scans inspect the tarball.

RN1 has exactly three pinned Revisium runtime dependencies: agent-runtime,
pipeline, and scripts. They are exact registry versions. A clean install and the
package consumer gate must not use
`file:`, `link:`, workspace, Git, URL, or temporary tarball dependencies.

Every change to the host must keep the readiness preflight, keyed live-relay
preflight, raw admission, interaction, public-schema, and fresh-process recovery
evidence applicable. Run `git diff --check` after verification.

Generic agent-runtime adapter tests must cover discovery, binding snapshots,
configuration and result mapping, credential lease cleanup, cancellation,
shutdown, active-state sink wiring, and fresh-process recovery. The package
consumer gate must prove the root-only public surface and reject deep imports;
live provider calls remain manual and are excluded from `verify`.

For workflow changes, run `actionlint` when it is available. Pull-request CI
waits for the Sonar Quality Gate, verifies that the analysis belongs to the exact
PR head, and rejects every open issue. On `master` and `release/**` pushes, CI
uploads analysis without scanner-side waiting or branch issue API polling. The
provider-owned `SonarCloud Code Analysis` check must exist and pass on the exact
branch SHA before merge, tagging, or publication; a missing, pending, failed, or
mismatched-SHA provider check blocks the operation.
