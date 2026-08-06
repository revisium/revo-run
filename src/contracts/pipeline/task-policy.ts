import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { IdentifierSchema, PositiveIntegerSchema } from '../schema-primitives.js';

export const RetryPolicySchema = Type.Object(
  {
    maximumAttempts: PositiveIntegerSchema,
    backoff: Type.Union([
      Type.Object(
        { kind: Type.Literal('constant'), delayMs: PositiveIntegerSchema },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal('exponential'),
          initialDelayMs: PositiveIntegerSchema,
          maximumDelayMs: PositiveIntegerSchema,
        },
        { additionalProperties: false },
      ),
    ]),
    retryableErrorCodes: Type.Array(IdentifierSchema, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export type RetryPolicy = DeepReadonly<Type.Static<typeof RetryPolicySchema>>;

export const RecoveryPolicySchema = Type.Union([
  Type.Object(
    {
      reconciliation: Type.Literal('unsupported'),
      unknownOutcome: Type.Literal('fail'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      reconciliation: Type.Literal('required'),
      maximumAttempts: PositiveIntegerSchema,
      timeoutMs: PositiveIntegerSchema,
      unknownOutcome: Type.Union([Type.Literal('fail'), Type.Literal('requireHumanResolution')]),
    },
    { additionalProperties: false },
  ),
]);

export type RecoveryPolicy = DeepReadonly<Type.Static<typeof RecoveryPolicySchema>>;
