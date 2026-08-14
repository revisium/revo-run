import Schema from 'typebox/schema';

import {
  RepeatIterationResultSchema,
  type RepeatIterationResult,
} from '../contracts/workflow/repeat-iteration-result.js';

const validator = Schema.Compile(RepeatIterationResultSchema);

export const parseRepeatIterationResult = (value: unknown): RepeatIterationResult => {
  if (!validator.Check(value)) {
    throw new Error('Repeat iteration result is invalid.');
  }
  return value;
};
