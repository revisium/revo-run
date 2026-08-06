import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  PipelineNodePathSchema,
} from '../schema-primitives.js';

export const BindingTargetSchema = Type.Object(
  {
    pipelineId: IdentifierSchema,
    nodePath: PipelineNodePathSchema,
  },
  { additionalProperties: false },
);

export type BindingTarget = DeepReadonly<Type.Static<typeof BindingTargetSchema>>;

export const AgentExecutorBindingSchema = Type.Object(
  {
    kind: Type.Literal('agent'),
    target: BindingTargetSchema,
    agentId: NonEmptyStringSchema,
    roleId: NonEmptyStringSchema,
    modelId: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

export type AgentExecutorBinding = DeepReadonly<Type.Static<typeof AgentExecutorBindingSchema>>;

export const ScriptExecutorBindingSchema = Type.Object(
  {
    kind: Type.Literal('script'),
    target: BindingTargetSchema,
    script: Type.Object(
      { id: NonEmptyStringSchema, version: NonEmptyStringSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ScriptExecutorBinding = DeepReadonly<Type.Static<typeof ScriptExecutorBindingSchema>>;

export const ExecutionBindingSchema = Type.Union([
  AgentExecutorBindingSchema,
  ScriptExecutorBindingSchema,
]);

export type ExecutionBinding = DeepReadonly<Type.Static<typeof ExecutionBindingSchema>>;
