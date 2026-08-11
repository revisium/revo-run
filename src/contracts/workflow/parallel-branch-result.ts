import Type from 'typebox';

import { NodeOutputSchema, type NodeOutput } from '../pipeline/node-output.js';
import { IdentifierSchema, PipelineNodePathSchema } from '../schema-primitives.js';

export const ParallelBranchResultSchema = Type.Object(
  {
    key: IdentifierSchema,
    outcome: IdentifierSchema,
    outputs: Type.Array(Type.Tuple([PipelineNodePathSchema, NodeOutputSchema])),
  },
  { additionalProperties: false },
);

type ParallelBranchResultStatic = Type.Static<typeof ParallelBranchResultSchema>;
type ParallelBranchOutputStatic = ParallelBranchResultStatic['outputs'][number];

export type ParallelBranchResult = Readonly<
  Omit<ParallelBranchResultStatic, 'outputs'> & {
    outputs: readonly (readonly [ParallelBranchOutputStatic[0], NodeOutput])[];
  }
>;
