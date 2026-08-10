import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunWorkflowInput } from '../../contracts/workflow/run-workflow-input.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { createRootScopeId } from '../../pipeline/identity/execution-identity.js';
import { RunWorkflowCoordinator } from '../coordination/run-workflow-coordinator.js';
import { DbosRunEventStream } from '../streams/run-event-stream.js';
import { runWorkflowId, scopeWorkflowId } from '../workflow-id.js';
import type { RunExecutionWorkflow } from './run-execution-workflow.js';

export type RunWorkflow = (input: RunWorkflowInput) => Promise<RunWorkflowResult>;

export const createRunWorkflow =
  (executionWorkflow: RunExecutionWorkflow): RunWorkflow =>
  async ({ runId, executionPlan }) => {
    if (DBOS.workflowID !== runWorkflowId(runId)) {
      throw new Error('Run workflow has an invalid DBOS workflow ID.');
    }

    const events = new DbosRunEventStream();
    try {
      const scopeId = createRootScopeId({ runId, rootPipelineId: executionPlan.rootPipelineId });
      const execution = await DBOS.startWorkflow(executionWorkflow, {
        workflowID: scopeWorkflowId(scopeId),
      })({ runId, scopeId });
      const coordinator = new RunWorkflowCoordinator(
        events,
        executionPlan.policies.maximumTotalNodeExecutions,
      );

      return await coordinator.execute(execution);
    } finally {
      await events.close();
    }
  };
