# Repository Contract

`src/index.ts` is the only public entrypoint. Public value and executor contracts live in
`src/contracts`, boundary validation in `src/validation`, and the public manager facade in
`src/manager`.

Deterministic pipeline interpretation and data resolution live in `src/pipeline` and must not
import DBOS. All DBOS SDK calls, workflow registration, durable steps, streams, and DBOS-backed
read models live in `src/dbos`.

## Navigation

- `src/manager`: consumer-facing lifecycle and run operations;
- `src/pipeline/interpreter`: deterministic graph traversal and node semantics;
- `src/pipeline/data`: input and output reference resolution;
- `src/dbos/workflows`: durable workflow entrypoints;
- `src/dbos/steps`: checkpointed external effects;
- `src/dbos/streams`: durable run events;
- `src/dbos/read-model`: DBOS records mapped to public run views;
- `test/support`: fixtures grouped by acceptance, executor, and process harness responsibility.
