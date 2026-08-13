import type { RunExecutionWorkflowInput } from '../../contracts/workflow/run-execution-workflow-input.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { parseRunExecutionWorkflowInput } from '../../validation/run-execution-workflow-input.validator.js';
import {
  ScopeCancellationError,
  ScopeFailureFenceError,
} from '../coordination/run-coordinator-v2-client.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { createPipelineExecutionV2 } from './create-pipeline-execution-v2.js';
import { loadRunWorkflowInput } from './load-run-workflow-input.js';
import type { ParallelBranchWorkflowV2Provider } from './parallel-branch-workflow-v2-provider.js';

export type RunExecutionWorkflowV2 = (
  input: RunExecutionWorkflowInput,
) => Promise<RunWorkflowResult>;

export const createRunExecutionWorkflowV2 =
  (
    executor: RunExecutorProvider,
    parallelBranchWorkflows: ParallelBranchWorkflowV2Provider,
    cancellation: ScopeCancellationRegistry,
  ): RunExecutionWorkflowV2 =>
  async (durableInput) => {
    const { runId, scopeId } = parseRunExecutionWorkflowInput(durableInput);
    const { coordinator, interpreter } = createPipelineExecutionV2(
      runId,
      executor,
      parallelBranchWorkflows,
      cancellation,
    );
    try {
      await coordinator.ready(`rr:run:v1:${runId}`);
      const { executionPlan, input } = await loadRunWorkflowInput(runId);
      const result = await interpreter.execute(executionPlan, runId, input, scopeId);
      await coordinator.finish();
      return result;
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
