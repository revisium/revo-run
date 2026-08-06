import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { PositiveIntegerSchema } from '../schema-primitives.js';

export const maximumExecutionPlanDepth = 32;

const ExecutionPlanDepthSchema = Type.Integer({
  minimum: 1,
  maximum: maximumExecutionPlanDepth,
});

export const ExecutionPoliciesSchema = Type.Object(
  {
    defaultTaskTimeoutMs: PositiveIntegerSchema,
    maximumActiveNodeExecutions: PositiveIntegerSchema,
    maximumNodeNestingDepth: ExecutionPlanDepthSchema,
    maximumSubpipelineDepth: ExecutionPlanDepthSchema,
    maximumTotalNodeExecutions: PositiveIntegerSchema,
  },
  { additionalProperties: false },
);

export type ExecutionPolicies = DeepReadonly<Type.Static<typeof ExecutionPoliciesSchema>>;
