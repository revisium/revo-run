import Schema from 'typebox/schema';

import { ConsensusVoteSchema, type ConsensusVote } from '../contracts/pipeline/consensus-vote.js';

const validator = Schema.Compile(ConsensusVoteSchema);

export const parseConsensusVote = (value: unknown): ConsensusVote => {
  if (!validator.Check(value)) {
    throw new Error('Consensus vote is invalid.');
  }
  return value;
};

export const asConsensusVote = (value: unknown): ConsensusVote | undefined =>
  validator.Check(value) ? value : undefined;
