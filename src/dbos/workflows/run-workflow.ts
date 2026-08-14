import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunWorkflowInput } from '../../contracts/workflow/run-workflow-input.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { createRootScopeId } from '../../pipeline/identity/execution-identity.js';
import { RunWorkflowCoordinator } from '../coordination/run-workflow-coordinator.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { ProviderCallRegistry } from '../executor/provider-call-registry.js';
import { DbosRunEventStream, RunEventBudgetExceededError } from '../streams/run-event-stream.js';
import { runWorkflowId, scopeWorkflowId } from '../workflow-id.js';
import type { RunExecutionWorkflow } from './run-execution-workflow.js';

export type RunWorkflow = (input: RunWorkflowInput) => Promise<RunWorkflowResult>;

export const createRunWorkflow = (
  executionWorkflow: RunExecutionWorkflow,
  cancellation: ScopeCancellationRegistry,
  providerCalls: ProviderCallRegistry,
): RunWorkflow =>
  async function run({ runId, executionPlan }) {
    if (DBOS.workflowID !== runWorkflowId(runId)) {
      throw new Error('Run workflow has an invalid DBOS workflow ID.');
    }
    const events = new DbosRunEventStream(runId);
    try {
      const scopeId = createRootScopeId({ runId, rootPipelineId: executionPlan.rootPipelineId });
      const executionWorkflowId = scopeWorkflowId(scopeId);
      const coordinator = new RunWorkflowCoordinator(
        runId,
        events,
        executionPlan.policies.maximumTotalNodeExecutions,
        cancellation,
        providerCalls,
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
