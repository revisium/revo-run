import Schema from 'typebox/schema';

import {
  DurableConsensusVerdictSchema,
  type DurableConsensusVerdict,
} from '../contracts/workflow/consensus-verdict.js';

const validator = Schema.Compile(DurableConsensusVerdictSchema);

export const parseDurableConsensusVerdict = (value: unknown): DurableConsensusVerdict => {
  if (!validator.Check(value)) {
    throw new Error('Durable consensus verdict is invalid.');
  }
  return value;
};
