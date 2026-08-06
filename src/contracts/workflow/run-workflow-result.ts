import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { NodeOutputSchema } from '../pipeline/node-output.js';
import { IdentifierSchema } from '../schema-primitives.js';

export const RunWorkflowResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('cancelled'),
      Type.Literal('failed'),
      Type.Literal('succeeded'),
    ]),
    outcome: IdentifierSchema,
    output: Type.Optional(NodeOutputSchema),
  },
  { additionalProperties: false },
);

export type RunWorkflowResult = DeepReadonly<Type.Static<typeof RunWorkflowResultSchema>>;
