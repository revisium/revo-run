import { isDeepStrictEqual } from 'node:util';

import Schema from 'typebox/schema';

import type { RunExecutorRequest } from '../contracts/executor/run-executor.js';
import { RunExecutorReconciliationResultSchema } from '../contracts/executor/run-executor.js';
import type { RunExecutorReconciliationResult } from '../contracts/executor/run-executor.js';
import {
  RunNodeEffectDecisionSchema,
  RunNodeEffectIntentSchema,
  RunNodeReconciliationSchema,
  type RunNodeEffectDecision,
  type RunNodeEffectIntent,
  type RunNodeReconciliation,
} from '../contracts/executor/run-node-recovery.js';

const intentValidator = Schema.Compile(RunNodeEffectIntentSchema);
const decisionValidator = Schema.Compile(RunNodeEffectDecisionSchema);
const reconciliationValidator = Schema.Compile(RunNodeReconciliationSchema);
export const RunExecutorReconciliationResultValidator = Schema.Compile(
  RunExecutorReconciliationResultSchema,
);

export const parseRunNodeEffectIntent = (value: unknown): RunNodeEffectIntent => {
  if (!intentValidator.Check(value)) {
    throw new Error('Stored node effect intent is invalid.');
  }
  return value;
};

export const parseRunNodeEffectDecision = (value: unknown): RunNodeEffectDecision => {
  if (!decisionValidator.Check(value)) {
    throw new Error('Stored node effect decision is invalid.');
  }
  return value;
};

export const parseRunNodeReconciliation = (value: unknown): RunNodeReconciliation => {
  if (!reconciliationValidator.Check(value)) {
    throw new Error('Stored node reconciliation is invalid.');
  }
  return value;
};

export const assertExpectedRunExecutorRequest = (
  stored: RunExecutorRequest,
  expected: RunExecutorRequest,
): void => {
  if (!isDeepStrictEqual(stored, expected)) {
    throw new Error('Stored node effect request does not match the expected request.');
  }
};

export const validReconciliationResult = (
  value: unknown,
): value is RunExecutorReconciliationResult =>
  RunExecutorReconciliationResultValidator.Check(value);
