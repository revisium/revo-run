import type { RunExecutionWorkflowInput } from '../../contracts/workflow/run-execution-workflow-input.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { parseRunExecutionWorkflowInput } from '../../validation/run-execution-workflow-input.validator.js';
import {
  ScopeCancellationError,
  ScopeFailureFenceError,
} from '../coordination/run-coordinator-client.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { ProviderCallRegistry } from '../executor/provider-call-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { createPipelineExecution } from './create-pipeline-execution.js';
import { loadRunWorkflowInput } from './load-run-workflow-input.js';
import type { MapItemWorkflowProvider } from './map-item-workflow-provider.js';
import type { ParallelBranchWorkflowProvider } from './parallel-branch-workflow-provider.js';
import type { RepeatIterationWorkflowProvider } from './repeat-iteration-workflow-provider.js';

export type RunExecutionWorkflow = (input: RunExecutionWorkflowInput) => Promise<RunWorkflowResult>;

export const createRunExecutionWorkflow = (
  executor: RunExecutorProvider,
  mapItemWorkflows: MapItemWorkflowProvider,
  parallelBranchWorkflows: ParallelBranchWorkflowProvider,
  repeatIterationWorkflows: RepeatIterationWorkflowProvider,
  cancellation: ScopeCancellationRegistry,
  providerCalls: ProviderCallRegistry,
): RunExecutionWorkflow =>
  async function runExecution(durableInput) {
    const { runId, scopeId } = parseRunExecutionWorkflowInput(durableInput);
    const { executionPlan, input } = await loadRunWorkflowInput(runId);
    const { coordinator, interpreter } = createPipelineExecution(
      runId,
      executionPlan.policies.maximumActiveNodeExecutions,
      {
        executor,
        mapItemWorkflows,
        parallelBranchWorkflows,
        repeatIterationWorkflows,
        cancellation,
        providerCalls,
      },
    );
    try {
      await coordinator.ready(`rr:run:${runId}`);
      const execution = await interpreter.execute(executionPlan, runId, input, scopeId);
      if (execution.provenance !== 'terminal' || execution.result.status !== 'cancelled') {
        await coordinator.finish();
      }
      return execution.result;
    } catch (error) {
      if (error instanceof ScopeCancellationError) {
        return { status: 'cancelled', outcome: 'cancelled' };
      }
      if (error instanceof ScopeFailureFenceError) {
        return { status: 'failed', outcome: 'event_budget_exceeded' };
      }
      throw error;
    } finally {
      cancellation.release(runId, scopeId);
      await coordinator.scopeSettled();
    }
  };
