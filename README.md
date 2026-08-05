# @revisium/revo-run

Durable run orchestration for Revo.

The package is being rebuilt for the `0.2.x` alpha line. The previous `0.1.x` runtime has been
removed.

```ts
import { createRunManager } from '@revisium/revo-run';

const manager = createRunManager({
  database: {
    url: process.env.DATABASE_URL,
  },
});

await manager.start();

const { runId } = await manager.startRun({
  runId: requestedRunId,
  executionPlan: compilation.template,
  input: { subject: 'example' },
});

const run = await manager.getRun(runId);
await manager.stop();
```

`ExecutionPlan` is the `PipelineExecutionTemplate` produced by `@revisium/revo-pipeline`. The
current vertical slice executes terminal-only pipelines; executable nodes will be added next. The
manager owns the process-local DBOS lifecycle, and DBOS stores the plan, input, status, and result.

Target responsibilities:

- translate pipeline decisions into durable workflow operations;
- represent runs, node executions, and attempts through the workflow engine;
- expose run summaries and detailed execution state;
- provide durable run updates and terminal waiting.
