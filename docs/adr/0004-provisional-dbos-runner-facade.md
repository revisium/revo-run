# ADR 0004: Provisional DBOS runner facade for the local MVP

- Status: Provisional
- Date: 2026-08-03
- Amends: [ADR 0002](0002-run-manager-boundary.md), for the unpublished `0.0.0` local MVP only
- Expires: Before any publish, deployment, tag, or release

## Context

The current feature branch needs an executable producer slice to validate exact-plan pipeline execution and package composition. The accepted durable `RunManager` design in ADR 0002 is not yet implemented end to end.

## Decision

For this unpublished local MVP, `createRunManager` may expose an experimental DBOS-backed runner facade. DBOS stays behind private composition/workflow modules, pipeline imports stay behind private lifecycle modules, one manager owns a serialized process-local lifecycle, and every admitted run retains its exact immutable plan pin. The public `RunSnapshotStore` is the MVP snapshot create/read/update seam; it is not the authoritative durable `RunStore` accepted by ADR 0002. Both `RunSnapshotStore` and `systemDatabaseUrl` expire with this exception and are not accepted public storage abstractions.

This exception does not establish the accepted durable `RunManager` or general recovery design. In particular it supplies no accepted Store transaction-time/CAS proof, leases or fencing, multi-manager or multi-process coordination, durable handoff, unknown-outcome reconciliation, retry/cancellation policy, durable subscriptions, or graceful drain guarantees.

## Expiry and required disposition

The exception MUST NOT cross a publish or deployment boundary. Before publication or deployment, the implementation MUST do exactly one of the following:

1. remove the DBOS facade, `RunSnapshotStore`, and its temporary configuration;
2. converge on ADR 0002 with the required durable-store and recovery evidence; or
3. replace ADR 0002 through a separately reviewed and accepted architecture decision.

The provisional facade and this exception must then be removed or superseded explicitly.
