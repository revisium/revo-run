import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { JsonValueSchema } from '../json-value.js';
import { NonEmptyStringSchema } from '../schema-primitives.js';
import { ExecutionPlanSchema } from './execution-plan.js';

export const StartRunInputSchema = Type.Object(
  {
    runId: NonEmptyStringSchema,
    executionPlan: ExecutionPlanSchema,
    input: JsonValueSchema,
  },
  { additionalProperties: false },
);

export type StartRunInput = DeepReadonly<Type.Static<typeof StartRunInputSchema>>;

export const StartRunResultSchema = Type.Object(
  { runId: NonEmptyStringSchema },
  { additionalProperties: false },
);

export type StartRunResult = DeepReadonly<Type.Static<typeof StartRunResultSchema>>;
