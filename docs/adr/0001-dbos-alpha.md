# ADR 0001: DBOS alpha execution

Status: Accepted

`revo-run` delegates continuation authority to DBOS. The package owns a stable DBOS application name, stable versioned workflow names, UUID run identities, deterministic framed child-workflow identities, and compact pipeline interpretation. Host snapshot storage is a read-model projection and is not continuation authority.

The alpha public boundary is only `createRunManager({ database: { url }, plans, executor, snapshots })` and the nine documented public types. Compatibility aliases, deep exports, canonical JSON, the earlier domain/store architecture, and configurable DBOS naming are intentionally removed before publication.
