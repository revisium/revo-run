import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunWorkflowInput } from '../../contracts/workflow/run-workflow-input.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { createRootScopeId } from '../../pipeline/identity/execution-identity.js';
import { RunWorkflowV2Coordinator } from '../coordination/run-workflow-v2-coordinator.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import { DbosRunEventStream, RunEventBudgetExceededError } from '../streams/run-event-stream.js';
import { runWorkflowId, scopeWorkflowV2Id } from '../workflow-id.js';
import type { RunExecutionWorkflowV2 } from './run-execution-workflow-v2.js';

export type RunWorkflowV2 = (input: RunWorkflowInput) => Promise<RunWorkflowResult>;

export const createRunWorkflowV2 =
  (
    executionWorkflow: RunExecutionWorkflowV2,
    cancellation: ScopeCancellationRegistry,
  ): RunWorkflowV2 =>
  async ({ runId, executionPlan }) => {
    if (DBOS.workflowID !== runWorkflowId(runId)) {
      throw new Error('Run workflow has an invalid DBOS workflow ID.');
    }
    const events = new DbosRunEventStream(runId);
    try {
      const scopeId = createRootScopeId({ runId, rootPipelineId: executionPlan.rootPipelineId });
      const executionWorkflowId = scopeWorkflowV2Id(scopeId);
      const coordinator = new RunWorkflowV2Coordinator(
        runId,
        events,
        executionPlan.policies.maximumTotalNodeExecutions,
        cancellation,
      );
      coordinator.registerRootScope(executionWorkflowId);
      const execution = await DBOS.startWorkflow(executionWorkflow, {
        workflowID: executionWorkflowId,
      })({ runId, scopeId });
      const result = await coordinator.execute(execution);
      if (!coordinator.eventBudgetExceeded && !coordinator.cancelled) {
        try {
          await events.append({
            type: result.status === 'succeeded' ? 'run.completed' : 'run.failed',
            data: { outcome: result.outcome },
          });
        } catch (error) {
          if (error instanceof RunEventBudgetExceededError) {
            return { status: 'failed', outcome: error.outcome };
          }
          throw error;
        }
      }
      return result;
    } finally {
      try {
        await events.close();
      } catch {
        // A terminal workflow status also closes subscriptions after their accepted prefix drains.
      }
    }
  };
