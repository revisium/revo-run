# Repository Contract

`src/index.ts` is the only public entrypoint. `src/manager.ts` owns process lifecycle and admission, `src/workflow.ts` owns DBOS workflows, `src/pipeline.ts` interprets compiled plans, and `src/snapshot.ts` defensively snapshots admission data. Host snapshots are a read model; DBOS is continuation authority.
