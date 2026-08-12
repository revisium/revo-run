import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { JsonValueSchema } from '../json-value.js';
import { ExecutionPlanSchema } from '../run/execution-plan.js';
import { RunIdSchema } from '../run/run-id.js';

export const AdmissionTokenSchema = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' });

export const RunWorkflowInputSchema = Type.Object(
  {
    runId: RunIdSchema,
    admissionToken: AdmissionTokenSchema,
    executionPlan: ExecutionPlanSchema,
    input: JsonValueSchema,
  },
  { additionalProperties: false },
);

export type RunWorkflowInput = DeepReadonly<Type.Static<typeof RunWorkflowInputSchema>>;

export const RunWorkflowArgumentsSchema = Type.Tuple([RunWorkflowInputSchema]);

export type RunWorkflowArguments = DeepReadonly<Type.Static<typeof RunWorkflowArgumentsSchema>>;
