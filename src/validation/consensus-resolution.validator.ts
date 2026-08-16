import Schema from 'typebox/schema';

import {
  ConsensusResolutionDirectiveSchema,
  type ConsensusResolutionDirective,
} from '../contracts/workflow/consensus-resolution.js';

const validator = Schema.Compile(ConsensusResolutionDirectiveSchema);

export const parseConsensusResolutionDirective = (value: unknown): ConsensusResolutionDirective => {
  if (!validator.Check(value)) {
    throw new Error('Consensus resolution directive is invalid.');
  }
  return value;
};
