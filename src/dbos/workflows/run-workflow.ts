import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunWorkflowInput } from '../../contracts/workflow/run-workflow-input.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { RunWorkflowCoordinator } from '../coordination/run-workflow-coordinator.js';
import { DbosRunEventStream } from '../streams/run-event-stream.js';
import type { RunExecutionWorkflow } from './run-execution-workflow.js';

export type RunWorkflow = (input: RunWorkflowInput) => Promise<RunWorkflowResult>;

export const createRunWorkflow =
  (executionWorkflow: RunExecutionWorkflow): RunWorkflow =>
  async ({ executionPlan }) => {
    const runId = DBOS.workflowID;
    if (runId === undefined) {
      throw new Error('Run workflow has no DBOS workflow ID.');
    }

    const events = new DbosRunEventStream();
    try {
      const execution = await DBOS.startWorkflow(executionWorkflow)({ runId });
      const coordinator = new RunWorkflowCoordinator(
        events,
        executionPlan.policies.maximumTotalNodeExecutions,
      );

      return await coordinator.execute(execution);
    } finally {
      await events.close();
    }
  };
