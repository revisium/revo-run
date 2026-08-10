import Schema from 'typebox/schema';

import { RunIdSchema } from '../contracts/run/run-id.js';

const RunIdValidator = Schema.Compile(RunIdSchema);

export const isValidRunId = (value: unknown): value is string => RunIdValidator.Check(value);
