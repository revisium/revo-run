import Schema from 'typebox/schema';

import { StartRunInputSchema } from '../contracts/run/start-run.js';
import type { StartRunInput } from '../contracts/run/start-run.js';
import { ExecutionPlanValidator } from './execution-plan.validator.js';

const StartRunInputValidator = Schema.Compile(StartRunInputSchema);

export const validateStartRunInput = (value: StartRunInput): void => {
  if (!StartRunInputValidator.Check(value)) {
    throw new Error('Start run input is invalid.');
  }

  const validation = ExecutionPlanValidator.Validate(value.executionPlan);
  if (!validation.valid) {
    throw new Error(`Execution plan is invalid: ${validation.code}.`);
  }
};
