import Schema from 'typebox/schema';

import {
  ParallelBranchResultSchema,
  type ParallelBranchResult,
} from '../contracts/workflow/parallel-branch-result.js';

const validator = Schema.Compile(ParallelBranchResultSchema);

export const parseParallelBranchResult = (value: unknown): ParallelBranchResult => {
  if (!validator.Check(value)) {
    throw new Error('Parallel branch workflow result is invalid.');
  }
  return value;
};
