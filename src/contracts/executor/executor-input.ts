import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { SecretReferenceSchema } from '../pipeline/data-reference.js';
import { OutputValueSchema } from '../pipeline/node-output.js';
import { IdentifierSchema } from '../schema-primitives.js';

export const ExecutorInputValueSchema = Type.Union([
  OutputValueSchema,
  Type.Object(
    { kind: Type.Literal('secret'), reference: SecretReferenceSchema },
    { additionalProperties: false },
  ),
]);

export type ExecutorInputValue = DeepReadonly<Type.Static<typeof ExecutorInputValueSchema>>;

export const ExecutorInputSchema = Type.Record(IdentifierSchema, ExecutorInputValueSchema, {
  additionalProperties: false,
});

export type ExecutorInput = DeepReadonly<Type.Static<typeof ExecutorInputSchema>>;
