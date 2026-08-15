import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import {
  NodeInstanceIdSchema,
  ScopeIdSchema,
  ScopeWorkflowIdSchema,
} from '../execution-identity.js';
import { ExecutorInputSchema } from '../executor/executor-input.js';
import { JsonValueSchema } from '../json-value.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { PipelineInputScopeSchema } from '../pipeline/pipeline-input.js';
import { PipelineNodeSchema } from '../pipeline/pipeline-node.schema.js';
import { RunIdSchema } from '../run/run-id.js';
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PipelineNodePathSchema,
  PositiveSafeIntegerSchema,
} from '../schema-primitives.js';
import { ScopeStartFenceReplySchema } from './run-coordinator-message.js';

export const MapItemDispositionSchema = Type.Union([
  Type.Literal('execute'),
  Type.Literal('settlementOnly'),
]);

export const MapItemWorkflowInputSchema = Type.Object(
  {
    runId: RunIdSchema,
    scopeId: ScopeIdSchema,
    parentScopeId: ScopeIdSchema,
    mapNodeInstanceId: NodeInstanceIdSchema,
    sourceIndex: NonNegativeIntegerSchema,
    itemKey: NonEmptyStringSchema,
    item: JsonValueSchema,
    node: PipelineNodeSchema,
    pipelineId: IdentifierSchema,
    pipelineInput: PipelineInputScopeSchema,
    runtimePath: NonEmptyStringSchema,
    parentPath: PipelineNodePathSchema,
    iterationInput: Type.Optional(ExecutorInputSchema),
    inheritedOutputs: Type.Array(
      Type.Object(
        { path: PipelineNodePathSchema, output: NodeOutputSchema },
        { additionalProperties: false },
      ),
    ),
    maximumParallelism: PositiveSafeIntegerSchema,
    parentWorkflowId: ScopeWorkflowIdSchema,
    disposition: MapItemDispositionSchema,
    startFence: ScopeStartFenceReplySchema,
  },
  { additionalProperties: false },
);

export const MapItemWorkflowArgumentsSchema = Type.Tuple([MapItemWorkflowInputSchema]);

export type MapItemWorkflowInput = DeepReadonly<Type.Static<typeof MapItemWorkflowInputSchema>>;
export type MapItemDisposition = DeepReadonly<Type.Static<typeof MapItemDispositionSchema>>;
