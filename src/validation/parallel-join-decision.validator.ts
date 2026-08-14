import Schema from 'typebox/schema';

import {
  DurableParallelJoinDecisionSchema,
  type DurableParallelJoinDecision,
} from '../contracts/workflow/parallel-join-decision.js';

const validator = Schema.Compile(DurableParallelJoinDecisionSchema);

export const parseDurableParallelJoinDecision = (value: unknown): DurableParallelJoinDecision => {
  if (!validator.Check(value)) {
    throw new Error('Stored parallel join decision is invalid.');
  }
  return value;
};
