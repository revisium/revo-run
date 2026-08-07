import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { ExecutorInputSchema, ExecutorInputValueSchema } from '../executor/executor-input.js';

export const PipelineInputScopeSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('value'), value: ExecutorInputValueSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('mapping'), values: ExecutorInputSchema },
    { additionalProperties: false },
  ),
]);

export type PipelineInputScope = DeepReadonly<Type.Static<typeof PipelineInputScopeSchema>>;
