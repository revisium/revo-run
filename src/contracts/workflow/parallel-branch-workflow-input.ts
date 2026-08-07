import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { PipelineInputScopeSchema } from '../pipeline/pipeline-input.js';
import { PipelineNodeSchema } from '../pipeline/pipeline-node.schema.js';
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  PipelineNodePathSchema,
  PositiveIntegerSchema,
} from '../schema-primitives.js';

export const ParallelBranchWorkflowInputSchema = Type.Object(
  {
    runId: NonEmptyStringSchema,
    branchKey: IdentifierSchema,
    node: PipelineNodeSchema,
    pipelineId: IdentifierSchema,
    pipelineInput: PipelineInputScopeSchema,
    runtimePath: NonEmptyStringSchema,
    parentPath: PipelineNodePathSchema,
    inheritedOutputs: Type.Array(
      Type.Object(
        { path: PipelineNodePathSchema, output: NodeOutputSchema },
        { additionalProperties: false },
      ),
    ),
    maximumParallelism: PositiveIntegerSchema,
  },
  { additionalProperties: false },
);

export const ParallelBranchWorkflowArgumentsSchema = Type.Tuple([
  ParallelBranchWorkflowInputSchema,
]);

export type ParallelBranchWorkflowInput = DeepReadonly<
  Type.Static<typeof ParallelBranchWorkflowInputSchema>
>;
