import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { PositiveSafeIntegerSchema } from '../schema-primitives.js';
import { RunExecutorReconciliationResultSchema, RunExecutorRequestSchema } from './run-executor.js';
import { RunNodeExecutionSchema } from './run-node-execution.js';

const RecoveryGenerationSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const RunNodeEffectIntentSchema = Type.Object(
  {
    kind: Type.Literal('runNodeEffectIntent'),
    request: RunExecutorRequestSchema,
    recoveryGeneration: RecoveryGenerationSchema,
  },
  { additionalProperties: false },
);

export type RunNodeEffectIntent = DeepReadonly<Type.Static<typeof RunNodeEffectIntentSchema>>;

const MustReconcileSchema = Type.Object(
  {
    kind: Type.Literal('mustReconcile'),
    request: RunExecutorRequestSchema,
    storedRecoveryGeneration: RecoveryGenerationSchema,
    liveRecoveryGeneration: RecoveryGenerationSchema,
  },
  { additionalProperties: false },
);

export const RunNodeEffectDecisionSchema = Type.Union([
  RunNodeExecutionSchema,
  MustReconcileSchema,
  Type.Object(
    { kind: Type.Literal('runNodeCancelled'), request: RunExecutorRequestSchema },
    { additionalProperties: false },
  ),
]);

export type RunNodeEffectDecision = DeepReadonly<Type.Static<typeof RunNodeEffectDecisionSchema>>;

export const RunNodeReconciliationSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('runNodeReconciliation'),
      request: RunExecutorRequestSchema,
      reconciliationRound: PositiveSafeIntegerSchema,
      result: RunExecutorReconciliationResultSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('reconciliationFailed'),
      request: RunExecutorRequestSchema,
      reconciliationRound: PositiveSafeIntegerSchema,
    },
    { additionalProperties: false },
  ),
]);

export type RunNodeReconciliation = DeepReadonly<Type.Static<typeof RunNodeReconciliationSchema>>;
