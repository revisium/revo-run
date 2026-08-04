# Repository Contract

`src/index.ts` is the only public entrypoint. Capability folders separate manager lifecycle, DBOS workflow runtime, compiled-plan interpretation, and snapshot transitions without creating additional package exports. Host snapshots are a read model; DBOS is continuation authority.
