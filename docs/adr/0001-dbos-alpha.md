# ADR 0001: DBOS alpha execution

Status: Accepted

`revo-run` delegates continuation and snapshot authority to DBOS. The package owns a stable DBOS application name, the disposable `revo-run.run.v2` workflow, deterministic framed external-execution identities, and compact generic `PipelineExecutionTemplate` interpretation. Caller-supplied opaque run identities pass to DBOS unchanged. Plans and run input are durable positional workflow arguments; public snapshots are mapped only from DBOS workflow status.

The alpha runtime boundary is only `createRunManager({ database: { url }, executor })`. Compatibility aliases, deep exports, host plan/snapshot stores, direct SQL, DBOS types, and configurable DBOS naming are intentionally absent before publication.
