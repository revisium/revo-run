import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { IdentifierSchema } from '../schema-primitives.js';

export const TerminalWorkflowResultSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal('failed'),
      outcome: IdentifierSchema,
      output: Type.Optional(NodeOutputSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal('cancelled'), outcome: Type.Literal('cancelled') },
    { additionalProperties: false },
  ),
]);

export type TerminalWorkflowResult = DeepReadonly<Type.Static<typeof TerminalWorkflowResultSchema>>;
