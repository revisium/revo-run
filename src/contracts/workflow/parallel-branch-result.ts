import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeOutputSchema, type NodeOutput } from '../pipeline/node-output.js';
import { IdentifierSchema, PipelineNodePathSchema } from '../schema-primitives.js';

export const ParallelBranchResultSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal('completed'),
      key: IdentifierSchema,
      outcome: IdentifierSchema,
      outputs: Type.Array(Type.Tuple([PipelineNodePathSchema, NodeOutputSchema])),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal('cancelled'), key: IdentifierSchema },
    { additionalProperties: false },
  ),
]);

type ParallelBranchResultStatic = Type.Static<typeof ParallelBranchResultSchema>;
type CompletedParallelBranchResultStatic = Extract<
  ParallelBranchResultStatic,
  { status: 'completed' }
>;
type ParallelBranchOutputStatic = CompletedParallelBranchResultStatic['outputs'][number];

export type ParallelBranchResult =
  | Readonly<
      Omit<CompletedParallelBranchResultStatic, 'outputs'> & {
        outputs: readonly (readonly [ParallelBranchOutputStatic[0], NodeOutput])[];
      }
    >
  | DeepReadonly<Extract<ParallelBranchResultStatic, { status: 'cancelled' }>>;
