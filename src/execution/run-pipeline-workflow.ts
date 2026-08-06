import type { RunWorkflowInput } from '../contracts/workflow/run-workflow-input.js';
import type { RunWorkflowResult } from '../contracts/workflow/run-workflow-result.js';

export const runPipelineWorkflow = async ({
  executionPlan,
}: RunWorkflowInput): Promise<RunWorkflowResult> => {
  const pipeline = Object.hasOwn(executionPlan.pipelines, executionPlan.rootPipelineId)
    ? executionPlan.pipelines[executionPlan.rootPipelineId]
    : undefined;
  if (pipeline === undefined) {
    throw new Error('Execution plan does not contain its root pipeline.');
  }

  if (pipeline.root.kind !== 'end') {
    throw new Error('Pipeline execution is not implemented yet.');
  }

  if (pipeline.root.output !== undefined) {
    throw new Error('Terminal output mappings are not implemented yet.');
  }

  return { status: pipeline.root.status, outcome: pipeline.root.outcome };
};
