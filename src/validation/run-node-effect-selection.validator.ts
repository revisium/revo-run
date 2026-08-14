import Schema from 'typebox/schema';

import {
  RunNodeEffectSelectionSchema,
  type RunNodeEffectSelection,
} from '../contracts/executor/run-node-effect-selection.js';

const validator = Schema.Compile(RunNodeEffectSelectionSchema);

export const parseRunNodeEffectSelection = (value: unknown): RunNodeEffectSelection => {
  if (!validator.Check(value)) {
    throw new Error('Stored node effect selection is invalid.');
  }
  return value;
};
