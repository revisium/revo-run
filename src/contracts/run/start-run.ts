import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { JsonValueSchema } from '../json-value.js';
import { ExecutionPlanSchema } from './execution-plan.js';
import { RunIdSchema } from './run-id.js';

export const StartRunInputSchema = Type.Object(
  {
    runId: RunIdSchema,
    executionPlan: ExecutionPlanSchema,
    input: JsonValueSchema,
  },
  { additionalProperties: false },
);

export type StartRunInput = DeepReadonly<Type.Static<typeof StartRunInputSchema>>;

export const StartRunResultSchema = Type.Object(
  { runId: RunIdSchema },
  { additionalProperties: false },
);

export type StartRunResult = DeepReadonly<Type.Static<typeof StartRunResultSchema>>;
