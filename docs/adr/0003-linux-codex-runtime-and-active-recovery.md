# ADR 0003: Linux Codex runtime and DBOS active recovery

## Status

Accepted. This decision supersedes the production-unavailable behavior in
[ADR 0002](0002-private-agent-runtime-port.md) while preserving its private,
root-unexported boundary.

## Decision

RN1 composes one private `@revisium/revo-agent-runtime` adapter for
`codex@definition-v1` on Linux. Consumers still cannot supply a runner, runtime,
provider factory, or definition. The definition version identifies this
consumer-owned contract and does not pin a Codex CLI version.

Admission requires an explicit model matching
`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`, `allowAmbientLogin: true`, a logical
workspace reference matching `[A-Za-z][A-Za-z0-9._-]{0,127}`, and no
`credentials` property. The adapter invokes Codex with argv beginning `exec`,
then `--ignore-user-config`, delivers the prompt byte-for-byte on stdin, and
ends argv with `--`, `-`. `HOME` and `CODEX_HOME` provide ambient authentication
state only; other user configuration is not inherited.

The adapter maps start to a closed `accepted`, `rejected`, or `unknown` outcome.
Workspace failures and classified runtime failures before acceptance become a
generic failed or cancelled terminal result. Unexpected post-start faults,
invalid handles, and identity or pin mismatches are unknown. Unknown never
starts a replacement invocation and becomes `recovery_required` in the durable
operation.

Terminal values pass through one recursive sanitizer for handle results,
lookups, and already-completed cancellation. It rejects secret- or
credential-shaped keys, including normalized acronym forms such as `APIKey`,
`AWS_ACCESS_KEY_ID`, `JWTToken`, `OAuthToken`, and `SSHPrivateKey`, plus absolute
POSIX/drive/UNC paths, file URIs, and captured secret values. Safe bounded JSON
is cloned and deeply frozen. Rejected data and raw runtime faults never enter
DBOS history.

Active process identity is stored as one closed, versioned registry document in
the DBOS system database. Its only dependencies are DBOS/PostgreSQL, the pinned
runtime `ActiveInvocationStateSink` contract, and the private Codex adapter. A
running/cancelling save or remove returns only after DBOS acknowledges the
versioned write. On startup the readiness fence stays closed while DBOS launches,
the registry loads, and runtime initialization identity-checks and reaps recorded
detached process groups. Removed rows are acknowledged before readiness opens.
Graceful stop closes and drains public calls, shuts agents down while DBOS can
acknowledge active-row removal, and shuts DBOS down only after agent shutdown
settles.

## Consequences

- DBOS/PostgreSQL remains the sole durable store; no package table, scheduler,
  public persistence API, or second database is introduced.
- A recovered terminal operation is not replayed. A recovered unknown operation
  is `recovery_required`, and its invocation count remains one.
- The pinned runtime uses spawn-before-active-save sequencing. A host `SIGKILL`
  in that narrow window can leave an unregistered orphan; this ADR does not
  claim stronger crash atomicity than the runtime provides.
- Live-provider calls are manual and excluded from automatic verification.
  Darwin, non-Codex adapters, public runtime injection, and CLI version pinning
  remain explicit non-claims.
- Governing requirements, vectors, exclusions, and digests are recorded under
  `docs/conformance/` and `test/fixtures/conformance/`.
