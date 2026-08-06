import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { CompiledPipelineSchema } from '../pipeline/compiled-pipeline.js';
import { IdentifierSchema } from '../schema-primitives.js';
import { ExecutionBindingSchema } from './execution-binding.js';
import { ExecutionPoliciesSchema } from './execution-policy.js';

export const ExecutionPlanSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    rootPipelineId: IdentifierSchema,
    pipelines: Type.Record(IdentifierSchema, CompiledPipelineSchema, {
      additionalProperties: false,
      minProperties: 1,
    }),
    bindings: Type.Array(ExecutionBindingSchema),
    policies: ExecutionPoliciesSchema,
  },
  { additionalProperties: false },
);

export type ExecutionPlan = DeepReadonly<Type.Static<typeof ExecutionPlanSchema>>;
