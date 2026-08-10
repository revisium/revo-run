import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { PositiveSafeIntegerSchema } from '../schema-primitives.js';

export const maximumExecutionPlanDepth = 32;

const ExecutionPlanDepthSchema = Type.Integer({
  minimum: 1,
  maximum: maximumExecutionPlanDepth,
});

export const ExecutionPoliciesSchema = Type.Object(
  {
    defaultTaskTimeoutMs: PositiveSafeIntegerSchema,
    maximumActiveNodeExecutions: PositiveSafeIntegerSchema,
    maximumNodeNestingDepth: ExecutionPlanDepthSchema,
    maximumSubpipelineDepth: ExecutionPlanDepthSchema,
    maximumTotalNodeExecutions: PositiveSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export type ExecutionPolicies = DeepReadonly<Type.Static<typeof ExecutionPoliciesSchema>>;
