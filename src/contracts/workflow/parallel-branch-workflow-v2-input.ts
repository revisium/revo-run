import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { ScopeWorkflowV2IdSchema } from '../execution-identity.js';
import { ParallelBranchWorkflowInputSchema } from './parallel-branch-workflow-input.js';

export const ParallelBranchWorkflowV2InputSchema = Type.Object(
  {
    ...ParallelBranchWorkflowInputSchema.properties,
    parentWorkflowId: ScopeWorkflowV2IdSchema,
  },
  { additionalProperties: false },
);

export const ParallelBranchWorkflowV2ArgumentsSchema = Type.Tuple([
  ParallelBranchWorkflowV2InputSchema,
]);

export type ParallelBranchWorkflowV2Input = DeepReadonly<
  Type.Static<typeof ParallelBranchWorkflowV2InputSchema>
>;
