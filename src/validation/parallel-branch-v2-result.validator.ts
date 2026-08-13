import Schema from 'typebox/schema';

import {
  ParallelBranchV2ResultSchema,
  type ParallelBranchV2Result,
} from '../contracts/workflow/parallel-branch-v2-result.js';

const validator = Schema.Compile(ParallelBranchV2ResultSchema);

export const parseParallelBranchV2Result = (value: unknown): ParallelBranchV2Result => {
  if (!validator.Check(value)) {
    throw new Error('Parallel branch workflow v2 result is invalid.');
  }
  return value;
};
