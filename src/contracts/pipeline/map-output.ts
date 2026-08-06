import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import {
  IdentifierSchema,
  NonNegativeIntegerSchema,
  NonEmptyStringSchema,
} from '../schema-primitives.js';
import { NodeOutputSchema } from './node-output.js';

export const MapItemFailureSchema = Type.Object(
  {
    itemKey: NonEmptyStringSchema,
    outcome: IdentifierSchema,
  },
  { additionalProperties: false },
);

export type MapItemFailure = DeepReadonly<Type.Static<typeof MapItemFailureSchema>>;

export const MapSummarySchema = Type.Object(
  {
    totalItems: NonNegativeIntegerSchema,
    completedItems: NonNegativeIntegerSchema,
    failedItems: NonNegativeIntegerSchema,
    failures: Type.Array(MapItemFailureSchema),
  },
  { additionalProperties: false },
);

export type MapSummary = DeepReadonly<Type.Static<typeof MapSummarySchema>>;

const MapSummaryOutputSchema = Type.Object({
  summary: Type.Object(
    {
      kind: Type.Literal('json'),
      value: MapSummarySchema,
    },
    { additionalProperties: false },
  ),
});

export const MapNodeOutputSchema = Type.Intersect([NodeOutputSchema, MapSummaryOutputSchema]);

export type MapNodeOutput = DeepReadonly<Type.Static<typeof MapNodeOutputSchema>>;
