import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { IdentifierSchema, NonEmptyStringSchema } from '../schema-primitives.js';

export const RunEventSchema = Type.Object(
  {
    cursor: NonEmptyStringSchema,
    type: NonEmptyStringSchema,
    path: Type.Optional(NonEmptyStringSchema),
    errorCode: Type.Optional(IdentifierSchema),
  },
  { additionalProperties: false },
);

export type RunEvent = DeepReadonly<Type.Static<typeof RunEventSchema>>;
