import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeOutputSchema, type NodeOutput } from '../pipeline/node-output.js';
import { IdentifierSchema, PipelineNodePathSchema } from '../schema-primitives.js';
import { TerminalWorkflowResultSchema } from './terminal-workflow-result.js';

export const ParallelBranchResultSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('continued'),
      key: IdentifierSchema,
      outcome: IdentifierSchema,
      outputs: Type.Array(Type.Tuple([PipelineNodePathSchema, NodeOutputSchema])),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('terminal'),
      key: IdentifierSchema,
      result: TerminalWorkflowResultSchema,
    },
    { additionalProperties: false },
  ),
]);

type ParallelBranchResultStatic = Type.Static<typeof ParallelBranchResultSchema>;
type ContinuedParallelBranchResultStatic = Extract<
  ParallelBranchResultStatic,
  { kind: 'continued' }
>;
type ParallelBranchOutputStatic = ContinuedParallelBranchResultStatic['outputs'][number];

export type ParallelBranchResult =
  | Readonly<
      Omit<ContinuedParallelBranchResultStatic, 'outputs'> & {
        outputs: readonly (readonly [ParallelBranchOutputStatic[0], NodeOutput])[];
      }
    >
  | DeepReadonly<Extract<ParallelBranchResultStatic, { kind: 'terminal' }>>;
