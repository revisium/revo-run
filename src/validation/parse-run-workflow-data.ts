import type { RunWorkflowInput } from '../contracts/workflow/run-workflow-input.js';
import type { RunWorkflowResult } from '../contracts/workflow/run-workflow-result.js';
import { ExecutionPlanValidator } from './execution-plan.validator.js';
import {
  RunWorkflowArgumentsValidator,
  RunWorkflowResultValidator,
} from './run-workflow.validator.js';

export const parseRunWorkflowInput = (value: unknown[] | undefined): RunWorkflowInput => {
  if (!RunWorkflowArgumentsValidator.Check(value)) {
    throw new Error('Run workflow input is invalid.');
  }

  const input = value[0];
  if (!ExecutionPlanValidator.Check(input.executionPlan)) {
    throw new Error('Run workflow input is invalid.');
  }

  return input;
};

export const parseRunWorkflowResult = (value: unknown): RunWorkflowResult => {
  if (!RunWorkflowResultValidator.Check(value)) {
    throw new Error('Run workflow output is invalid.');
  }

  return value;
};
