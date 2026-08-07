import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunNodeExecution } from '../../contracts/executor/run-node-execution.js';
import { parseRunNodeExecution } from '../../validation/run-node-execution.validator.js';
import { isNodeExecutionStepName } from '../dbos-names.js';

type StepInfo = NonNullable<Awaited<ReturnType<typeof DBOS.listWorkflowSteps>>>[number];

const executionFrom = (step: StepInfo): RunNodeExecution | undefined => {
  if (!isNodeExecutionStepName(step.name) || step.error !== null) {
    return undefined;
  }

  return parseRunNodeExecution(step.output);
};

const loadWorkflowExecutions = async (
  workflowId: string,
  ancestors: ReadonlySet<string>,
): Promise<RunNodeExecution[]> => {
  if (ancestors.has(workflowId)) {
    return [];
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(workflowId);
  const steps = (await DBOS.listWorkflowSteps(workflowId)) ?? [];
  const executions = await Promise.all(
    steps.map(async (step) => {
      const nested =
        step.childWorkflowID === null
          ? []
          : await loadWorkflowExecutions(step.childWorkflowID, nextAncestors);
      const execution = executionFrom(step);
      return execution === undefined ? nested : [execution, ...nested];
    }),
  );

  return executions.flat();
};

export const loadRunNodeExecutions = (runId: string): Promise<RunNodeExecution[]> =>
  loadWorkflowExecutions(runId, new Set());
