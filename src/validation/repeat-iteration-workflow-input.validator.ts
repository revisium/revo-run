import Schema from 'typebox/schema';

import {
  RepeatIterationWorkflowArgumentsSchema,
  RepeatIterationWorkflowInputSchema,
  type RepeatIterationWorkflowInput,
} from '../contracts/workflow/repeat-iteration-workflow-input.js';

const validator = Schema.Compile(RepeatIterationWorkflowInputSchema);
const argumentsValidator = Schema.Compile(RepeatIterationWorkflowArgumentsSchema);

const invalidInput = (): Error => new Error('Repeat iteration workflow input is invalid.');

export const parseRepeatIterationWorkflowInput = (value: unknown): RepeatIterationWorkflowInput => {
  if (!validator.Check(value)) {
    throw invalidInput();
  }
  return value;
};

export const RepeatIterationWorkflowArgumentsParser = {
  parse(value: unknown): unknown {
    if (!argumentsValidator.Check(value)) {
      throw invalidInput();
    }
    return value;
  },
};
