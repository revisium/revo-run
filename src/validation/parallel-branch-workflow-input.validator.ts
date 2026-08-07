import Schema from 'typebox/schema';

import {
  ParallelBranchWorkflowArgumentsSchema,
  ParallelBranchWorkflowInputSchema,
  type ParallelBranchWorkflowInput,
} from '../contracts/workflow/parallel-branch-workflow-input.js';

const validator = Schema.Compile(ParallelBranchWorkflowInputSchema);
const argumentsValidator = Schema.Compile(ParallelBranchWorkflowArgumentsSchema);

const invalidInput = (): Error => new Error('Parallel branch workflow input is invalid.');

export const parseParallelBranchWorkflowInput = (value: unknown): ParallelBranchWorkflowInput => {
  if (!validator.Check(value)) {
    throw invalidInput();
  }

  return value;
};

export const ParallelBranchWorkflowArgumentsParser = {
  parse(value: unknown): unknown {
    if (!argumentsValidator.Check(value)) {
      throw invalidInput();
    }

    return value;
  },
};
