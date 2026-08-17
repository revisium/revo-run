# Repository Contract

`src/index.ts` is the only public entrypoint. `src/contracts` owns Revo public and durable value
contracts, while private schemas for provider-owned DBOS envelopes live in `src/validation`.
Boundary validation stays in `src/validation`, and the public manager facade stays in `src/manager`.
Approved in-memory contracts may use TypeScript `Date` and `AbortSignal` types; they do not become
serialized durable DTOs merely to satisfy JSON-schema conventions.

Deterministic pipeline interpretation and data resolution live in `src/pipeline` and must not
import DBOS. All DBOS SDK calls, workflow registration, durable steps, streams, and DBOS-backed
read models live in `src/dbos`.

## Navigation

- `src/manager`: consumer-facing lifecycle and run operations;
- `src/pipeline/interpreter`: deterministic graph traversal and node semantics; wait and effect ports live in dedicated `*-ports.ts` modules so DBOS adapters do not import executor classes;
- `src/pipeline/parallel`: DBOS-independent parallel join and remaining-branch settlement semantics and branch port;
- `src/pipeline/data`: input and output reference resolution;
- `src/dbos/coordination`: durable run messages, event ordering, and total-execution admission;
- `src/dbos/parallel`: child-branch scheduling and settlement action interpretation behind the pipeline branch port;
- `src/dbos/workflows`: durable workflow entrypoints;
- `src/dbos/steps`: checkpointed external effects;
- `src/dbos/streams`: durable run events;
- `src/dbos/read-model`: DBOS records mapped to public run views;
- `test/support`: fixtures grouped by acceptance, executor, and process harness responsibility;
- `test/package`: public-surface consumer tests; import only `src/index.ts`; run with `pnpm test:package`;
- `examples/quick-start.ts`: tracked consumer example imported only as `@revisium/revo-run`;
- `scripts/packed-consumer.ts`: isolated packed-surface assertions imported only as `@revisium/revo-run`;
- `scripts/verify-package.mjs`: pack contents, publint, attw, and isolated tarball consumer.
