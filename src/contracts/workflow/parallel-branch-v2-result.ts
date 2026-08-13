import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeOutputSchema, type NodeOutput } from '../pipeline/node-output.js';
import { IdentifierSchema, PipelineNodePathSchema } from '../schema-primitives.js';

export const ParallelBranchV2ResultSchema = Type.Union([
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

type ParallelBranchV2ResultStatic = Type.Static<typeof ParallelBranchV2ResultSchema>;
type CompletedParallelBranchV2ResultStatic = Extract<
  ParallelBranchV2ResultStatic,
  { status: 'completed' }
>;
type ParallelBranchV2OutputStatic = CompletedParallelBranchV2ResultStatic['outputs'][number];

export type ParallelBranchV2Result =
  | Readonly<
      Omit<CompletedParallelBranchV2ResultStatic, 'outputs'> & {
        outputs: readonly (readonly [ParallelBranchV2OutputStatic[0], NodeOutput])[];
      }
    >
  | DeepReadonly<Extract<ParallelBranchV2ResultStatic, { status: 'cancelled' }>>;
