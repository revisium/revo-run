import Schema from 'typebox/schema';

import { RunExecutorResultSchema } from '../contracts/executor/run-executor.js';

export const RunExecutorResultValidator = Schema.Compile(RunExecutorResultSchema);
