import Schema from 'typebox/schema';

import {
  DurableMapControlDecisionSchema,
  type DurableMapControlDecision,
} from '../contracts/workflow/map-control-decision.js';

const validator = Schema.Compile(DurableMapControlDecisionSchema);

export const parseDurableMapControlDecision = (value: unknown): DurableMapControlDecision => {
  if (!validator.Check(value)) {
    throw new Error('Stored map control decision is invalid.');
  }
  return value;
};
