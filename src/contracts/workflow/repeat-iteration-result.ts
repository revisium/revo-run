import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { IdentifierSchema, PositiveSafeIntegerSchema } from '../schema-primitives.js';
import { TerminalWorkflowResultSchema } from './terminal-workflow-result.js';

const ContinuedRepeatIterationResultSchema = Type.Object(
  {
    kind: Type.Literal('continued'),
    ordinal: PositiveSafeIntegerSchema,
    outcome: IdentifierSchema,
    output: Type.Optional(NodeOutputSchema),
  },
  { additionalProperties: false },
);

const TerminalRepeatIterationResultSchema = Type.Object(
  {
    kind: Type.Literal('terminal'),
    ordinal: PositiveSafeIntegerSchema,
    result: TerminalWorkflowResultSchema,
  },
  { additionalProperties: false },
);

export const RepeatIterationResultSchema = Type.Union([
  ContinuedRepeatIterationResultSchema,
  TerminalRepeatIterationResultSchema,
]);

export type RepeatIterationResult = DeepReadonly<Type.Static<typeof RepeatIterationResultSchema>>;
