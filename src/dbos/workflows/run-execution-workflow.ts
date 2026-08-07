import type { RunExecutionWorkflowInput } from '../../contracts/workflow/run-execution-workflow-input.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { parseRunExecutionWorkflowInput } from '../../validation/run-execution-workflow-input.validator.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { createPipelineExecution } from './create-pipeline-execution.js';
import { loadRunWorkflowInput } from './load-run-workflow-input.js';
import type { ParallelBranchWorkflowProvider } from './parallel-branch-workflow-provider.js';

export type RunExecutionWorkflow = (input: RunExecutionWorkflowInput) => Promise<RunWorkflowResult>;

export const createRunExecutionWorkflow =
  (
    executor: RunExecutorProvider,
    parallelBranchWorkflows: ParallelBranchWorkflowProvider,
  ): RunExecutionWorkflow =>
  async (durableInput) => {
    const { runId } = parseRunExecutionWorkflowInput(durableInput);
    const { coordinator, interpreter } = createPipelineExecution(
      runId,
      executor,
      parallelBranchWorkflows,
    );

    try {
      const { executionPlan, input } = await loadRunWorkflowInput(runId);
      return await interpreter.execute(executionPlan, runId, input);
    } finally {
      await coordinator.scopeSettled();
    }
  };
