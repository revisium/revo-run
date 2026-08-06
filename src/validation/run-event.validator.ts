import Schema from 'typebox/schema';

import { RunEventSchema } from '../contracts/run/run-event.js';
import type { RunEvent } from '../contracts/run/run-event.js';

const RunEventValidator = Schema.Compile(RunEventSchema);

export const parseRunEvent = (value: unknown): RunEvent => {
  if (!RunEventValidator.Check(value)) {
    throw new Error('Stored run event is invalid.');
  }

  return value;
};
