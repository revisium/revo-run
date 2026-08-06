import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { JsonValueSchema } from '../json-value.js';
import {
  IdentifierSchema,
  JsonPointerSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  PipelineNodePathSchema,
} from '../schema-primitives.js';

export const ArtifactReferenceSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    digest: NonEmptyStringSchema,
    mediaType: NonEmptyStringSchema,
    size: NonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);

export type ArtifactReference = DeepReadonly<Type.Static<typeof ArtifactReferenceSchema>>;

export const EntityReferenceSchema = Type.Object(
  {
    entityType: IdentifierSchema,
    id: NonEmptyStringSchema,
    version: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

export type EntityReference = DeepReadonly<Type.Static<typeof EntityReferenceSchema>>;

export const SecretReferenceSchema = Type.Object(
  { name: NonEmptyStringSchema },
  { additionalProperties: false },
);

export type SecretReference = DeepReadonly<Type.Static<typeof SecretReferenceSchema>>;

const LiteralSourceSchema = Type.Object(
  { kind: Type.Literal('literal'), value: JsonValueSchema },
  { additionalProperties: false },
);

const RunInputSourceSchema = Type.Object(
  { kind: Type.Literal('runInput'), path: JsonPointerSchema },
  { additionalProperties: false },
);

const PipelineInputSourceSchema = Type.Object(
  { kind: Type.Literal('pipelineInput'), path: JsonPointerSchema },
  { additionalProperties: false },
);

const NodeOutputSourceSchema = Type.Object(
  {
    kind: Type.Literal('nodeOutput'),
    nodePath: PipelineNodePathSchema,
    outputKey: IdentifierSchema,
    path: Type.Optional(JsonPointerSchema),
  },
  { additionalProperties: false },
);

const IterationInputSourceSchema = Type.Object(
  { kind: Type.Literal('iterationInput'), path: JsonPointerSchema },
  { additionalProperties: false },
);

const IterationOutputSourceSchema = Type.Object(
  {
    kind: Type.Literal('iterationOutput'),
    outputKey: IdentifierSchema,
    path: Type.Optional(JsonPointerSchema),
  },
  { additionalProperties: false },
);

const MapItemSourceSchema = Type.Object(
  { kind: Type.Literal('mapItem'), path: JsonPointerSchema },
  { additionalProperties: false },
);

const ArtifactSourceSchema = Type.Object(
  { kind: Type.Literal('artifact'), reference: ArtifactReferenceSchema },
  { additionalProperties: false },
);

const EntitySourceSchema = Type.Object(
  { kind: Type.Literal('entity'), reference: EntityReferenceSchema },
  { additionalProperties: false },
);

const SecretSourceSchema = Type.Object(
  { kind: Type.Literal('secret'), reference: SecretReferenceSchema },
  { additionalProperties: false },
);

export const TerminalOutputSourceSchema = Type.Union([
  LiteralSourceSchema,
  RunInputSourceSchema,
  PipelineInputSourceSchema,
  NodeOutputSourceSchema,
  IterationInputSourceSchema,
  IterationOutputSourceSchema,
  MapItemSourceSchema,
  ArtifactSourceSchema,
  EntitySourceSchema,
]);

export type TerminalOutputSource = DeepReadonly<Type.Static<typeof TerminalOutputSourceSchema>>;

export const InputSourceSchema = Type.Union([TerminalOutputSourceSchema, SecretSourceSchema]);

export type InputSource = DeepReadonly<Type.Static<typeof InputSourceSchema>>;
