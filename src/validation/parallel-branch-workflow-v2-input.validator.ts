import Schema from 'typebox/schema';

import {
  ParallelBranchWorkflowV2ArgumentsSchema,
  ParallelBranchWorkflowV2InputSchema,
  type ParallelBranchWorkflowV2Input,
} from '../contracts/workflow/parallel-branch-workflow-v2-input.js';

const validator = Schema.Compile(ParallelBranchWorkflowV2InputSchema);
const argumentsValidator = Schema.Compile(ParallelBranchWorkflowV2ArgumentsSchema);

export const parseParallelBranchWorkflowV2Input = (
  value: unknown,
): ParallelBranchWorkflowV2Input => {
  if (!validator.Check(value)) {
    throw new Error('Parallel branch workflow v2 input is invalid.');
  }
  return value;
};

export const ParallelBranchWorkflowV2ArgumentsParser = {
  parse(value: unknown): unknown {
    if (!argumentsValidator.Check(value)) {
      throw new Error('Parallel branch workflow v2 input is invalid.');
    }
    return value;
  },
};
