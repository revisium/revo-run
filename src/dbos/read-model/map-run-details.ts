import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunNodeExecution } from '../../contracts/executor/run-node-execution.js';
import type { RunDetails } from '../../contracts/run/run-details.js';
import type { RunSnapshot } from '../../contracts/run/run.js';
import { parseRunNodeExecution } from '../../validation/run-node-execution.validator.js';
import { isNodeExecutionStepName } from '../dbos-names.js';

type StepInfo = NonNullable<Awaited<ReturnType<typeof DBOS.listWorkflowSteps>>>[number];

const executionFrom = (step: StepInfo): readonly RunNodeExecution[] => {
  if (!isNodeExecutionStepName(step.name) || step.error !== null) {
    return [];
  }

  return [parseRunNodeExecution(step.output)];
};

export const mapRunDetails = (run: RunSnapshot, steps: readonly StepInfo[]): RunDetails => ({
  run,
  nodeExecutions: steps.flatMap(executionFrom),
});
