# Revo Run Repository

This repository is the durable logical-attempt kernel for Revo. Repository
contracts win for concrete commands and boundaries.

- Package manager: pnpm 11.13.0; runtime: Node `>=24.11.1 <25`.
- Language: strict TypeScript, ESM, NodeNext.
- Run `pnpm verify` before handoff; use [VERIFICATION.md](./VERIFICATION.md).
- Read [REPOSITORY.md](./REPOSITORY.md), [REVIEW.md](./REVIEW.md), the relevant
  architecture/ADR/spec, and the public export map before editing.
- Do not commit directly to `master`, push, create/update a PR, merge, tag, or
  publish without the corresponding approval.
- `@revisium/revo-pipeline` and `@revisium/revo-agent-runtime` are forbidden
  dependencies and imports in Phase 1. The Pipeline adapter is Phase 2
  design-only, not code or an export.
- Keep durable/public values JSON-compatible, bounded, canonicalized through
  the one package-owned JCS path, and explicitly versioned.
