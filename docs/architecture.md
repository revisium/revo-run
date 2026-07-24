# Architecture

## Status

The public JSON/digest utilities are implemented. All lifecycle, store,
controller, provider, redaction, artifact, and adapter behavior below is a
versioned contract for later Phase-1 slices unless source/tests/export say
otherwise.

## Durable logical attempt boundary

A logical attempt has caller-owned `runId`, kernel-generated `attemptId`, one
exact provider pin, ordered immutable evidence, and one terminal result. The
`RunController` and pure reducer are the only transition authority. A provider
only reports observations; it cannot write durable state.

`EvidenceStore.createAttempt` atomically writes accepted revision/sequence 1.
Its only later writable operation is CAS `transition`; it commits the evidence
event and reducer-produced record together or neither. Readers never see a
partial transition.

The controller is intentionally single-owner in Phase 1. CAS losers reload and
stop; they never resend provider actions automatically. Recovery uses a stored
provider coordinate and exact pin, fails closed on uncertainty, and never uses a
PID alone.

## Integration boundary

`@revisium/revo-run` imports neither the Pipeline nor Agent Runtime packages.
The future runtime adapter owns one physical invocation and native reconciliation.
The future Pipeline adapter maps one verified plan to one start and one committed
terminal result to one pipeline receipt. Only a future public Pipeline API can
advance graph state. No Phase-2 adapter source or export exists here.

## Canonical durable profile

All durable/public documents use one RFC 8785 JCS canonical UTF-8 path and
`sha256:<lowercase hex>` identities. Envelope fields are closed and explicitly
versioned. Generated identifiers, timestamps, revisions, sequences, and a
self-digest are excluded from digests.
