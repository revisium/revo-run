import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { RunExecutorRequestSchema, RunExecutorResultSchema } from './run-executor.js';

export const RunNodeExecutionSchema = Type.Object(
  {
    kind: Type.Literal('runNodeExecution'),
    request: RunExecutorRequestSchema,
    result: RunExecutorResultSchema,
  },
  { additionalProperties: false },
);

export type RunNodeExecution = DeepReadonly<Type.Static<typeof RunNodeExecutionSchema>>;
