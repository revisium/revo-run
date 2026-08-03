# @revisium/revo-run

Alpha DBOS-backed durable pipeline execution for Revo.

```ts
import { createRunManager } from '@revisium/revo-run';

const manager = createRunManager({ database: { url }, plans, executor, snapshots });
await manager.start();
const run = await manager.startRun({ planPin, input });
await manager.stop();
```

The package owns DBOS configuration, workflow names, durable continuation, and run IDs. The host supplies exact plans, execution, and a required snapshot read model. `startRun` returns after DBOS durably acknowledges immutable admission, before snapshot delivery. DBOS retries each failed pending, running, or terminal delivery durably with capped backoff until it succeeds; a permanent outage leaves the workflow pending that delivery rather than reporting false success. Terminal delivery retries reuse the already computed outcome and never re-execute or reclassify it. Retrying a successfully acknowledged request creates a new run. The public package has one runtime export and no deep entrypoints.
