import Schema from 'typebox/schema';

import type { RunManagerErrorCode } from '../contracts/run/run-manager-error.js';
import { StartRunInputSchema } from '../contracts/run/start-run.js';
import { ExecutionPlanValidator } from './execution-plan.validator.js';

const StartRunInputValidator = Schema.Compile(StartRunInputSchema);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const validateStartRunInput = (value: unknown): RunManagerErrorCode | undefined => {
  if (!StartRunInputValidator.Check(value)) {
    const [, errors] = StartRunInputValidator.Errors(value);
    if (errors.some(({ instancePath }) => instancePath === '/runId')) {
      return 'invalid_run_id';
    }
    const executionPlan = isRecord(value) ? value['executionPlan'] : undefined;
    const planValidation = ExecutionPlanValidator.Validate(executionPlan);
    return planValidation.valid ? 'invalid_start_run_input' : planValidation.code;
  }

  const validation = ExecutionPlanValidator.Validate(value.executionPlan);
  if (!validation.valid) {
    return validation.code;
  }

  return undefined;
};
