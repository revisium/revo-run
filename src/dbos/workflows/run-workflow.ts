import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunWorkflowInput } from '../../contracts/workflow/run-workflow-input.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { PipelineInterpreter } from '../../pipeline/interpreter/pipeline-interpreter.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { NodeExecutionStep } from '../steps/node-execution-step.js';
import { DbosRunEventStream } from '../streams/run-event-stream.js';

export type RunWorkflow = (input: RunWorkflowInput) => Promise<RunWorkflowResult>;

export const createRunWorkflow =
  (executor: RunExecutorProvider): RunWorkflow =>
  async ({ executionPlan, input }) => {
    const runId = DBOS.workflowID;
    if (runId === undefined) {
      throw new Error('Run workflow has no DBOS workflow ID.');
    }

    const events = new DbosRunEventStream();
    const nodeExecution = new NodeExecutionStep(executor);
    const interpreter = new PipelineInterpreter(
      (request, timeoutMs) => nodeExecution.execute(request, timeoutMs),
      events,
    );

    try {
      return await interpreter.execute(executionPlan, runId, input);
    } finally {
      await events.close();
    }
  };
