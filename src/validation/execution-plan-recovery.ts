import type { PipelineNode } from '../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../contracts/run/execution-plan.js';
import type { RunManagerErrorCode } from '../contracts/run/run-manager-error.js';
import { pipelineNodes } from './pipeline-node-traversal.js';

const tasks = (plan: ExecutionPlan): readonly Extract<PipelineNode, { readonly kind: 'task' }>[] =>
  pipelineNodes(Object.values(plan.pipelines).map(({ root }) => root)).filter(
    (node): node is Extract<PipelineNode, { readonly kind: 'task' }> => node.kind === 'task',
  );

export const recoveryAdmissionError = (
  plan: ExecutionPlan,
  reconciliationAvailable: boolean,
): RunManagerErrorCode | undefined => {
  const recoveryPolicies = tasks(plan).flatMap(({ recovery }) =>
    recovery === undefined ? [] : [recovery],
  );
  if (recoveryPolicies.some(({ unknownOutcome }) => unknownOutcome === 'requireHumanResolution')) {
    return 'recovery_human_resolution_unsupported';
  }
  if (
    !reconciliationAvailable &&
    recoveryPolicies.some(({ reconciliation }) => reconciliation === 'required')
  ) {
    return 'recovery_reconcile_required';
  }
  return undefined;
};
