import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { ScopeIdSchema, ScopeWorkflowIdSchema } from '../execution-identity.js';
import { ExecutorInputSchema } from '../executor/executor-input.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { PipelineInputScopeSchema } from '../pipeline/pipeline-input.js';
import { PipelineNodeSchema } from '../pipeline/pipeline-node.schema.js';
import { RunIdSchema } from '../run/run-id.js';
import {
  IdentifierSchema,
  NonEmptyStringSchema,
  PipelineNodePathSchema,
  PositiveSafeIntegerSchema,
} from '../schema-primitives.js';
import { ScopeStartFenceReplySchema } from './run-coordinator-message.js';

export const ParallelBranchDispositionSchema = Type.Union([
  Type.Literal('execute'),
  Type.Literal('settlementOnly'),
]);

export const ParallelBranchWorkflowInputSchema = Type.Object(
  {
    runId: RunIdSchema,
    scopeId: ScopeIdSchema,
    branchKey: IdentifierSchema,
    node: PipelineNodeSchema,
    pipelineId: IdentifierSchema,
    pipelineInput: PipelineInputScopeSchema,
    runtimePath: NonEmptyStringSchema,
    parentPath: PipelineNodePathSchema,
    nodePathPrefix: Type.Optional(PipelineNodePathSchema),
    iterationInput: Type.Optional(ExecutorInputSchema),
    inheritedOutputs: Type.Array(
      Type.Object(
        { path: PipelineNodePathSchema, output: NodeOutputSchema },
        { additionalProperties: false },
      ),
    ),
    maximumParallelism: PositiveSafeIntegerSchema,
    parentWorkflowId: ScopeWorkflowIdSchema,
    disposition: ParallelBranchDispositionSchema,
    startFence: ScopeStartFenceReplySchema,
  },
  { additionalProperties: false },
);

export const ParallelBranchWorkflowArgumentsSchema = Type.Tuple([
  ParallelBranchWorkflowInputSchema,
]);

export type ParallelBranchWorkflowInput = DeepReadonly<
  Type.Static<typeof ParallelBranchWorkflowInputSchema>
>;
