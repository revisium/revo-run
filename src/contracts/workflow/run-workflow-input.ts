import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { JsonValueSchema } from '../json-value.js';
import { ExecutionPlanSchema } from '../run/execution-plan.js';

export const RunWorkflowInputSchema = Type.Object(
  {
    executionPlan: ExecutionPlanSchema,
    input: JsonValueSchema,
  },
  { additionalProperties: false },
);

export type RunWorkflowInput = DeepReadonly<Type.Static<typeof RunWorkflowInputSchema>>;

export const RunWorkflowArgumentsSchema = Type.Tuple([RunWorkflowInputSchema]);

export type RunWorkflowArguments = DeepReadonly<Type.Static<typeof RunWorkflowArgumentsSchema>>;
