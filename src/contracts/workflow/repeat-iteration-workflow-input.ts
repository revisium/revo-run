import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { ScopeIdSchema, ScopeWorkflowIdSchema } from '../execution-identity.js';
import { ExecutorInputSchema } from '../executor/executor-input.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { PipelineInputScopeSchema } from '../pipeline/pipeline-input.js';
import { RepeatBodyNodeSchema } from '../pipeline/pipeline-node.schema.js';
import { RunIdSchema } from '../run/run-id.js';
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  PipelineNodePathSchema,
  PositiveSafeIntegerSchema,
} from '../schema-primitives.js';
import { ScopeStartFenceReplySchema } from './run-coordinator-message.js';

export const RepeatIterationWorkflowInputSchema = Type.Object(
  {
    runId: RunIdSchema,
    scopeId: ScopeIdSchema,
    parentScopeId: ScopeIdSchema,
    ordinal: PositiveSafeIntegerSchema,
    node: RepeatBodyNodeSchema,
    pipelineId: IdentifierSchema,
    pipelineInput: PipelineInputScopeSchema,
    iterationInput: ExecutorInputSchema,
    runtimePath: NonEmptyStringSchema,
    parentPath: PipelineNodePathSchema,
    inheritedOutputs: Type.Array(
      Type.Object(
        { path: PipelineNodePathSchema, output: NodeOutputSchema },
        { additionalProperties: false },
      ),
    ),
    maximumParallelism: PositiveSafeIntegerSchema,
    parentWorkflowId: ScopeWorkflowIdSchema,
    startFence: ScopeStartFenceReplySchema,
  },
  { additionalProperties: false },
);

export const RepeatIterationWorkflowArgumentsSchema = Type.Tuple([
  RepeatIterationWorkflowInputSchema,
]);

export type RepeatIterationWorkflowInput = DeepReadonly<
  Type.Static<typeof RepeatIterationWorkflowInputSchema>
>;
