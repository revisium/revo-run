# ADR 0002: Durable multi-run manager boundary

- Status: Accepted
- Date: 2026-07-24
- Supersedes: [ADR 0001](0001-run-state-boundary.md)

## Context

ADR 0001 left polling, execution, retries, recovery, and coordination in a host
`RunWorker`. That split exposed the attempt protocol and allowed hosts to
implement different safety rules. The reusable boundary instead needs to be the
single library component a host starts, queries, and stops for many durable
runs.

## Decision

`RunManager` is the public facade and owns the complete durable run lifecycle:
coordination, execution, recovery, pipeline and human-gate progression,
cancellation, observation, and graceful drain. The host injects a
framework-neutral store, exact immutable plans and executor contracts,
identifier generation, and process-local policy; it retains transports, auth,
projections, plan compilation, adapters, and deployment.

The package uses a nine-layer dependency DAG. `lifecycle` is the only writable
domain/storage path. Its public `index.ts` is a pipeline-free facade; only
private `lifecycle/pipeline/**` modules may import
`@revisium/revo-pipeline`. `manager` imports only the lifecycle facade, while
`composition` wires storage, ports, lifecycle, and manager. Root exports remain
curated.

Durable authority is based on database transaction time, CAS, manager
incarnation, leases, and fences. Recovery takeover is allowed only after lease
expiry according to database time or an explicit durable handoff written under
the incumbent fence. Plan and executor pins are exact and immutable; there is no
latest or compatible fallback. The package does not promise physical
exactly-once execution.

## Alternatives considered

- Keep an attempt-only transition engine here and a host `RunWorker`: rejected
  because it splits one safety protocol across packages.
- Make events authoritative and recover by replay: rejected because current
  durable state must remain directly queryable.
- Ship a store-specific service or daemon: rejected because this package is an
  injected library with framework-neutral contracts.
- Expose pipeline-owned plan types through ports or the public facade: rejected
  because it couples the package boundary and emitted declarations to pipeline
  internals.

## Consequences

- Hosts integrate one manager and no longer implement low-level attempt
  coordination.
- Multi-process correctness requires real transactional-store proof.
- Exact pins, fenced handoff, conservative unknown outcomes, and durable pull
  observation make recovery explicit and reviewable.
- The package owns more runtime behavior but remains infrastructure-neutral and
  cannot guarantee physical exactly-once side effects.
