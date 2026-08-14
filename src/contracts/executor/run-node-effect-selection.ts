import Type from 'typebox';

import type { DeepReadonly } from '../deep-readonly.js';
import { RunExecutorRequestSchema } from './run-executor.js';

const RecoveryGenerationSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const RunNodeEffectSelectionSchema = Type.Object(
  {
    kind: Type.Literal('runNodeEffectSelection'),
    request: RunExecutorRequestSchema,
    mode: Type.Union([Type.Literal('execute'), Type.Literal('reconcile')]),
    storedRecoveryGeneration: RecoveryGenerationSchema,
    liveRecoveryGeneration: RecoveryGenerationSchema,
  },
  { additionalProperties: false },
);

export type RunNodeEffectSelection = DeepReadonly<Type.Static<typeof RunNodeEffectSelectionSchema>>;
