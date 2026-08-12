import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import {
  type AttemptId,
  AttemptIdSchema,
  AuthoredNodeIdSchema,
  NodeInstanceIdSchema,
  ScopeIdSchema,
} from '../execution-identity.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { ExecutionBindingSchema } from '../run/execution-binding.js';
import { RunIdSchema } from '../run/run-id.js';
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  PipelineNodePathSchema,
  PositiveSafeIntegerSchema,
} from '../schema-primitives.js';
import { ExecutorInputSchema } from './executor-input.js';

export const RunExecutorRequestSchema = Type.Object(
  {
    runId: RunIdSchema,
    authoredNodeId: AuthoredNodeIdSchema,
    scopeId: ScopeIdSchema,
    nodeInstanceId: NodeInstanceIdSchema,
    attemptId: AttemptIdSchema,
    attemptOrdinal: PositiveSafeIntegerSchema,
    displayPath: NonEmptyStringSchema,
    pipelineId: IdentifierSchema,
    nodePath: PipelineNodePathSchema,
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

export const RunExecutorReconciliationResultSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('effectCompleted'),
      result: Type.Object(
        {
          kind: Type.Literal('completed'),
          outcome: IdentifierSchema,
          output: Type.Optional(NodeOutputSchema),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('effectFailed'), error: ExecutionErrorSchema },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('effectNotFound') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('outcomeUnknown') }, { additionalProperties: false }),
]);

export type RunExecutorReconciliationResult = DeepReadonly<
  Type.Static<typeof RunExecutorReconciliationResultSchema>
>;

export interface RunExecutorContext {
  readonly signal: AbortSignal;
}

export interface RunExecutor {
  execute(request: RunExecutorRequest, context: RunExecutorContext): Promise<RunExecutorResult>;
  reconcile?(
    request: RunExecutorRequest,
    attemptId: AttemptId,
    context: RunExecutorContext,
  ): Promise<RunExecutorReconciliationResult>;
}
