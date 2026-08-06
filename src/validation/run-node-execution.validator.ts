import Schema from 'typebox/schema';

import { RunNodeExecutionSchema } from '../contracts/executor/run-node-execution.js';
import type { RunNodeExecution } from '../contracts/executor/run-node-execution.js';

const RunNodeExecutionValidator = Schema.Compile(RunNodeExecutionSchema);

export const parseRunNodeExecution = (value: unknown): RunNodeExecution => {
  if (!RunNodeExecutionValidator.Check(value)) {
    throw new Error('Stored node execution is invalid.');
  }

  return value;
};
