import type { RetryPolicy } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';

const maximumDurationMs = 86_400_000;

export const snapshotRetryPolicy = (value: unknown): RetryPolicy => {
  const record = contractValidation.snapshotRecord(value, [
    'backoffMultiplier',
    'initialBackoffMs',
    'maximumAttempts',
    'maximumBackoffMs',
  ]);
  const initialBackoffMs = contractValidation.boundedInteger(
    record['initialBackoffMs'],
    0,
    maximumDurationMs,
  );
  const maximumBackoffMs = contractValidation.boundedInteger(
    record['maximumBackoffMs'],
    0,
    maximumDurationMs,
  );
  if (maximumBackoffMs < initialBackoffMs) {
    throw new RangeError('Retry maximum backoff must not be less than its initial backoff.');
  }

  return Object.freeze({
    backoffMultiplier: contractValidation.boundedInteger(record['backoffMultiplier'], 1, 16),
    initialBackoffMs,
    maximumAttempts: contractValidation.boundedInteger(record['maximumAttempts'], 1, 100),
    maximumBackoffMs,
  });
};
