import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { JsonValueSchema } from '../json-value.js';
import { IdentifierSchema } from '../schema-primitives.js';
import { ArtifactReferenceSchema, EntityReferenceSchema } from './data-reference.js';

export const OutputValueSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('json'), value: JsonValueSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('artifact'), reference: ArtifactReferenceSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('entity'), reference: EntityReferenceSchema },
    { additionalProperties: false },
  ),
]);

export type OutputValue = DeepReadonly<Type.Static<typeof OutputValueSchema>>;

export const NodeOutputSchema = Type.Record(IdentifierSchema, OutputValueSchema, {
  additionalProperties: false,
});

export type NodeOutput = DeepReadonly<Type.Static<typeof NodeOutputSchema>>;
