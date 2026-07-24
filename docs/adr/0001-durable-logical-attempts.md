# ADR 0001: Durable logical attempts

- Status: Accepted architectural decision
- Date: 2026-07-24

## Decision

Build `@revisium/revo-run` as an ESM TypeScript kernel for durable logical
attempts. It owns identity, durable lifecycle, immutable evidence, cancellation
intent, terminal-envelope normalization, and safe recovery. It imports neither
`@revisium/revo-pipeline` nor `@revisium/revo-agent-runtime`.

The future Agent Runtime adapter owns exactly one physical invocation and native
cleanup/reconciliation. The future Pipeline adapter owns graph state, gate
semantics, retry scheduling, and graph-next-node choice. The controller/reducer
is the sole attempt transition authority.

## Consequences

Durable contracts use one RFC 8785 JCS path and SHA-256 over its UTF-8 bytes.
Provider observations pass redaction before persistence. EvidenceStore commits
record and event atomically under CAS. Pipeline integration remains design-only
until a versioned installed public Pipeline API and tarball consumer proof exist.

This records the repository decision; it does not represent approval of any
external service, release, or implementation beyond shipped source.
