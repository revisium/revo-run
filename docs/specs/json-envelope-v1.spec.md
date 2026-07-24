# JSON Envelope v1

- Status: Stable durable contract; implementation is limited to canonical JSON
  and digest utilities in this PR.

Every durable/public document is a closed object with
`schemaVersion: 'revo-run/<kind>/v1'`. Unknown fields reject. Optional fields
are absent; nullable fields are present with `null`. Timestamps are UTC RFC3339
with milliseconds. Counts, sequences, revisions, durations, and byte sizes are
non-negative JavaScript safe integers.

Values use RFC 8785 JCS canonical UTF-8 bytes through one internal canonicalizer.
Reject getters, `toJSON`, sparse arrays, cycles, `undefined`, bigint, functions,
symbols, non-finite numbers, and unpaired surrogates. A digest is
`sha256:<64 lowercase hex>` over canonical bytes, with no newline. It excludes
generated IDs, timestamps, sequence/revision, and self digest. Stored values
retain their schemaVersion, original canonical bytes, and digest. A required
field, nullability, meaning, or state-vocabulary change requires v2.

`runId` is caller-owned opaque ASCII, 1–128 characters,
`[A-Za-z0-9][A-Za-z0-9._:-]*`. `attemptId` is `rra_<lowercase UUIDv7>`;
`commandId` is `cmd_<lowercase UUIDv7>` and is idempotent within `(runId,
commandId)`. `eventId` is `rre_<lowercase UUIDv7>`. Provider invocation IDs are
safe opaque strings of 1–256 characters. Artifact IDs are opaque, non-filesystem
URI-like values.

Replaying a start command returns the original snapshot only when its canonical
command payload is byte-identical; otherwise reject
`revo.run.idempotency_conflict`.

## Exact v1 wire rules

All shapes are closed. Unknown fields, missing required fields, wrong types,
range/regex failures, and cross-field failures return:

```ts
type ContractErrorV1 = {
  schemaVersion: 'revo-run/contract-error/v1';
  code:
    | 'revo.run.contract_invalid'
    | 'revo.run.idempotency_conflict'
    | 'revo.run.transition_conflict'
    | 'revo.run.provider_observation_conflict'
    | 'revo.run.provider_protocol_error'
    | 'revo.run.provider_timeout';
  path: string;
  rule: string;
  message: string;
  retryable: boolean;
};
```

`path` is RFC 6901 (empty allowed); `rule` is lowercase snake case 1..64; and
`message` is sanitized UTF-8 <=512 bytes. JsonValue canonical UTF-8 is <=1 MiB
unless stated smaller. SafeInt is 0..9007199254740991; Timestamp is exactly UTC
`YYYY-MM-DDTHH:mm:ss.sssZ`; Sha256 is `sha256:<64 lowercase hex>`; UuidV7 is a
lowercase hyphenated UUIDv7.

```ts
type StartAttemptV1 = {
  schemaVersion: 'revo-run/start-attempt/v1';
  runId: string;
  commandId: `cmd_${UuidV7}`;
  priorAttemptId?: `rra_${UuidV7}`;
  executionPin: { providerId: string; definitionId: string; version: string; digest: Sha256 };
  input: JsonValue;
  resultContract: { schemaId: string; version: string; digest: Sha256 } | null;
  limits: { wallClockMs: SafeInt; idleMs: SafeInt | null; cancelGraceMs: SafeInt };
  callerCorrelation: string | null;
};
```

runId matches `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. providerId matches
`[a-z][a-z0-9-]{0,62}`; definitionId is 1..128 safe ASCII
`[A-Za-z0-9][A-Za-z0-9._:-]*`; exact pin/result versions are printable ASCII
1..64; schemaId is safe ASCII 1..128; input is <=1 MiB; callerCorrelation is
sanitized opaque <=128 bytes. wallClockMs is 1..86,400,000, idleMs is null or
1..wallClockMs, and cancelGraceMs is 0..600,000. requestDigest hashes every
StartAttempt field. Same `(runId,commandId)` and requestDigest returns the
original Snapshot; a different digest is idempotency_conflict at `/commandId`.

```ts
type AttemptStateV1 =
  | 'accepted'
  | 'preparing'
  | 'running'
  | 'cancellation_requested'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'recovery_blocked';
type TerminalStateV1 = 'succeeded' | 'failed' | 'cancelled' | 'recovery_blocked';
type ProviderCoordinateV1 = {
  providerInvocationId: string;
  recoveryToken: string | null;
  observedAt: Timestamp;
};
type AttemptRecordV1 = {
  schemaVersion: 'revo-run/attempt-record/v1';
  runId: string;
  attemptId: `rra_${UuidV7}`;
  commandId: `cmd_${UuidV7}`;
  requestDigest: Sha256;
  executionPin: StartAttemptV1['executionPin'];
  state: AttemptStateV1;
  revision: SafeInt;
  lastSequence: SafeInt;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  providerCoordinate: ProviderCoordinateV1 | null;
  terminal: TerminalResultV1 | null;
};
type SnapshotV1 = {
  schemaVersion: 'revo-run/snapshot/v1';
  record: AttemptRecordV1;
  committedEvent: EvidenceEventV1;
  globalCursor: string;
};
type ConflictV1 = {
  schemaVersion: 'revo-run/conflict/v1';
  code:
    | 'revo.run.transition_conflict'
    | 'revo.run.idempotency_conflict'
    | 'revo.run.provider_observation_conflict';
  snapshot: SnapshotV1;
};
```

Provider invocation IDs are safe opaque UTF-8 1..256; recoveryToken is safe
opaque <=512 and never credential/PID-only. revision/lastSequence are >=1 and
equal; terminal is non-null iff state is terminal. providerCoordinate is null in
accepted, non-null in running/cancellation_requested/cancelling, and preparing
may be non-null only at the spawn-to-coordinate-commit boundary. globalCursor is
opaque safe bytes 1..256.

```ts
type OpaqueIdV1 = string; // `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`
type GitObjectIdV1 = string; // lowercase `[0-9a-f]{40}|[0-9a-f]{64}`
type ExternalLocatorV1 =
  | { kind: 'git-commit'; repositoryId: OpaqueIdV1; commit: GitObjectIdV1 }
  | { kind: 'github-commit'; repositoryId: OpaqueIdV1; commit: GitObjectIdV1 }
  | { kind: 'revisium-revision'; projectId: OpaqueIdV1; revisionId: OpaqueIdV1 };
type ArtifactRefV1 = {
  schemaVersion: 'revo-run/artifact-ref/v1';
  mode: 'inline' | 'content-addressed' | 'external';
  mediaType: string;
  contentDigest: Sha256 | null;
  bytes: SafeInt | null;
  inline: JsonValue | null;
  locator: ExternalLocatorV1 | null;
  immutableRevision: string | null;
  retentionClass: 'ephemeral' | 'run' | 'retained';
};
type SafeProjectionV1 = {
  schemaVersion: 'revo-run/safe-projection/v1';
  category: 'activity' | 'started' | 'terminal' | 'cancel' | 'recovery' | 'provider_error';
  code: string | null;
  summary: string | null;
  elapsedMs: SafeInt | null;
  usage: { inputTokens: SafeInt | null; outputTokens: SafeInt | null } | null;
  artifacts: ArtifactRefV1[];
};
type TerminalResultV1 = {
  schemaVersion: 'revo-run/terminal-result/v1';
  outcome: TerminalStateV1;
  terminalKind: string;
  providerFailureCode: string | null;
  retryClassification: 'retryable' | 'not_retryable' | 'unknown';
  routingSignal: string | null;
  completedAt: Timestamp;
  safeProjection: SafeProjectionV1;
};
type ProviderObservationV1 = {
  schemaVersion: 'revo-run/provider-observation/v1';
  providerInvocationId: string;
  providerEventId: string;
  observedAt: Timestamp;
  kind: 'activity' | 'started' | 'terminal' | 'cancel_ack' | 'recovery';
  safeProjection: SafeProjectionV1;
  safeProjectionDigest: Sha256;
  terminal: TerminalResultV1 | null;
};
```

mediaType is ASCII token/subtype 1..127; code/terminalKind match
`[a-z][a-z0-9._-]{0,63}`; summary <=4096 bytes; artifacts <=32; providerEventId
is safe opaque 1..256; failure/routing strings are safe <=128. A terminal is
present iff observation kind is terminal. safeProjectionDigest hashes exactly
safeProjection. Inline artifacts require inline/bytes/digest and null
locator/revision with inline <=65,536 canonical bytes. Content-addressed
requires digest/bytes and all inline/locator/revision null. External requires
closed locator, immutableRevision/bytes and null inline; digest is nullable.
External locator kind selects its exact closed field set. Redaction precedes validation/digest/store and
forbids prompts, raw events, credential/token/auth/environment, stack,
source/diff blobs, private content, and arbitrary filesystem paths.

For external mode: `git-commit` requires `git:<commit>`;
`github-commit` requires `github:<repositoryId>@<commit>`; and
`revisium-revision` requires `revisium:<projectId>@<revisionId>` exactly,
byte-for-byte. locator, immutableRevision, and bytes are required/non-null;
inline is null. Inline/content-addressed modes require locator and revision null.
Locators are provider-assigned opaque identities, never URLs, paths, branches,
tags, refs, provider configuration, files, directories, workspaces, containers,
network mounts, or mutable external resources.

Validation uses ContractErrorV1 with code `revo.run.contract_invalid`, retryable
false, sanitized message, and these exact path/rule pairs: missing external
locator/revision/bytes is `external_locator_required` at the relevant field;
unknown locator field is `unknown_field` at that field; absent/unsupported kind
is `locator_kind_invalid` at `/locator/kind`; invalid identifier is
`locator_identifier_invalid`; non-lowercase/non-40-or-64-hex commit is
`locator_commit_invalid` at `/locator/commit`; a non-derived revision is
`locator_revision_mismatch` at `/immutableRevision`; locator/revision outside
external mode is `artifact_mode_invariant`; and URI-looking (`^[A-Za-z][A-Za-z0-9+.-]*:`), slash, backslash, `%2f`, or `@`
identifier is `locator_forbidden_coordinate`. Rejected coordinate values are
never copied into errors, projections, artifacts, or restricted diagnostics.

ArtifactRefV1 root is itself closed: exactly `schemaVersion`, `mode`,
`mediaType`, `contentDigest`, `bytes`, `inline`, `locator`,
`immutableRevision`, and `retentionClass` are allowed. schemaVersion is exactly
`revo-run/artifact-ref/v1`; mediaType is an ASCII token/subtype of 3..127 bytes;
non-null contentDigest is Sha256; bytes is null or SafeInt; and retentionClass
is exactly ephemeral, run, or retained. Unknown root fields reject with
`unknown_field` at their RFC 6901 pointer. Invalid common fields reject before
any digest/persistence using `schema_version_invalid`, `media_type_invalid`,
`sha256_invalid`, `safe_int_invalid`, or `retention_class_invalid` respectively.

Mode matrices are exact. `inline` requires non-null canonical JsonValue inline,
null locator/revision, and non-null bytes/contentDigest exactly equal to its JCS
UTF-8 byte length and Sha256; canonical inline bytes are capped at 65,536 and an
excess rejects at `/inline` with `inline_bytes_exceeded`. `content-addressed` requires non-null bytes and
contentDigest with null inline/locator/revision. `external` requires non-null
bytes/locator/revision, null inline, and nullable contentDigest. Any mismatch is
`artifact_mode_invariant` at its offending field before a safeProjection digest
or persistence write.

```ts
type EvidenceKindV1 =
  | 'accepted'
  | 'prepare_started'
  | 'provider_started'
  | 'activity_observed'
  | 'cancellation_requested'
  | 'cancel_dispatched'
  | 'provider_terminal_observed'
  | 'recovery_observed'
  | 'completed'
  | 'recovery_blocked';
type EvidenceEventV1 = {
  schemaVersion: 'revo-run/evidence-event/v1';
  eventId: `rre_${UuidV7}`;
  runId: string;
  attemptId: `rra_${UuidV7}`;
  sequence: SafeInt;
  revision: SafeInt;
  kind: EvidenceKindV1;
  occurredAt: Timestamp;
  causedByCommandId: `cmd_${UuidV7}` | null;
  safeProjection: SafeProjectionV1 | null;
  providerObservation: ProviderObservationV1 | null;
  terminal: TerminalResultV1 | null;
};
```

sequence/revision are >=1 and equal. accepted is exactly sequence/revision 1
with both nullable fields null. provider/activity/recovery kinds require an
observation; provider_terminal_observed and completed require terminal;
completed terminal equals record terminal; every other kind has terminal null.
