import Schema from 'typebox/schema';

import {
  RunExecutionWorkflowArgumentsSchema,
  RunExecutionWorkflowInputSchema,
  type RunExecutionWorkflowInput,
} from '../contracts/workflow/run-execution-workflow-input.js';

const validator = Schema.Compile(RunExecutionWorkflowInputSchema);
const argumentsValidator = Schema.Compile(RunExecutionWorkflowArgumentsSchema);

const invalidInput = (): Error => new Error('Run execution workflow input is invalid.');

export const parseRunExecutionWorkflowInput = (value: unknown): RunExecutionWorkflowInput => {
  if (!validator.Check(value)) {
    throw invalidInput();
  }

  return value;
};

export const RunExecutionWorkflowArgumentsParser = {
  parse(value: unknown): unknown {
    if (!argumentsValidator.Check(value)) {
      throw invalidInput();
    }

    return value;
  },
};
