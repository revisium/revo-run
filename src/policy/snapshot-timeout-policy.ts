import type { TimeoutPolicy } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';

const maximumDurationMs = 86_400_000;

export const snapshotTimeoutPolicy = (value: unknown): TimeoutPolicy => {
  const record = contractValidation.snapshotRecord(value, [
    'cancellationTimeoutMs',
    'executionTimeoutMs',
    'reconciliationTimeoutMs',
  ]);
  return Object.freeze({
    cancellationTimeoutMs: contractValidation.boundedInteger(
      record['cancellationTimeoutMs'],
      1,
      maximumDurationMs,
    ),
    executionTimeoutMs: contractValidation.boundedInteger(
      record['executionTimeoutMs'],
      1,
      maximumDurationMs,
    ),
    reconciliationTimeoutMs: contractValidation.boundedInteger(
      record['reconciliationTimeoutMs'],
      1,
      maximumDurationMs,
    ),
  });
};
