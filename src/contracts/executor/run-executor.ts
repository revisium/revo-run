import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { ExecutionBindingSchema } from '../run/execution-binding.js';
import { IdentifierSchema, NonEmptyStringSchema } from '../schema-primitives.js';
import { ExecutorInputSchema } from './executor-input.js';

export const RunExecutorRequestSchema = Type.Object(
  {
    executionId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    pipelineId: IdentifierSchema,
    nodePath: NonEmptyStringSchema,
    binding: ExecutionBindingSchema,
    input: ExecutorInputSchema,
  },
  { additionalProperties: false },
);

export type RunExecutorRequest = DeepReadonly<Type.Static<typeof RunExecutorRequestSchema>>;

const ExecutionErrorSchema = Type.Object(
  { code: IdentifierSchema, message: NonEmptyStringSchema },
  { additionalProperties: false },
);

export const RunExecutorResultSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('completed'),
      outcome: IdentifierSchema,
      output: Type.Optional(NodeOutputSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('failed'), error: ExecutionErrorSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('inputResolutionFailed'), error: ExecutionErrorSchema },
    { additionalProperties: false },
  ),
]);

export type RunExecutorResult = DeepReadonly<Type.Static<typeof RunExecutorResultSchema>>;

export interface RunExecutorContext {
  readonly signal: AbortSignal;
}

export interface RunExecutor {
  execute(request: RunExecutorRequest, context: RunExecutorContext): Promise<RunExecutorResult>;
}
