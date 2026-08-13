import type { PipelineNode } from '../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../contracts/run/execution-plan.js';
import type { RunManagerErrorCode } from '../contracts/run/run-manager-error.js';
import { pipelineNodes } from './pipeline-node-traversal.js';

const nodes = (plan: ExecutionPlan): readonly PipelineNode[] =>
  pipelineNodes(Object.values(plan.pipelines).map(({ root }) => root));

export const executionPlanAdmissionError = (
  plan: ExecutionPlan,
  reconciliationAvailable: boolean,
): RunManagerErrorCode | undefined => {
  const allNodes = nodes(plan);
  if (allNodes.some((node) => node.kind === 'parallel' && node.join.remaining === 'cancel')) {
    return 'invalid_execution_plan';
  }
  if (
    !reconciliationAvailable &&
    allNodes.some((node) => node.kind === 'task' && node.recovery?.reconciliation === 'required')
  ) {
    return 'recovery_reconcile_required';
  }
  return undefined;
};
