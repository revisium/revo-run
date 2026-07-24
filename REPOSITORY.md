# Repository Contract

`@revisium/revo-run` owns a reusable durable logical-attempt boundary. It is a
library, not a workflow engine, provider runtime, worker, scheduler, database
framework, or API service.

## Source of truth

1. Implemented source, tests, and `package.json#exports` describe shipped behavior.
2. Accepted ADRs define architectural decisions.
3. Stable versioned specifications define the durable contract.
4. Architecture explains responsibility and dependency direction.
5. README summarizes shipped status.

## Ownership and direction

The kernel owns attempt identity, lifecycle transitions, immutable evidence,
cancellation intent, terminal-envelope normalization, and recovery semantics.
The future `RunController` is the only transition authority and the only holder
of the writable `EvidenceStore` port.

The future Agent Runtime adapter owns one physical invocation and provider-native
cleanup/reconciliation. The future Pipeline adapter owns graph state, gate
meaning, workflow retry scheduling, and the only graph-next-node decision.
Providers can report observations but cannot persist or change attempt state.

```text
caller -> revo-run kernel -> EvidenceStore
                         -> ExecutionProvider (future port)
Pipeline adapter (Phase 2) -> public pipeline API (future)
```

Production has no import or dependency on `@revisium/revo-pipeline` or
`@revisium/revo-agent-runtime`. No deep imports, adapters, or compatibility
aliases bypass this boundary.

## Current status

Only the canonical JSON/digest public utilities are implemented. Lifecycle,
controller, store, provider, redaction implementation, artifacts, and all
Pipeline-adapter code remain unimplemented. Design documents must never be
presented as executable behavior.
