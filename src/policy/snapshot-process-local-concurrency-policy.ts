import type { ProcessLocalConcurrencyPolicy } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';

export const snapshotProcessLocalConcurrencyPolicy = (
  value: unknown,
): ProcessLocalConcurrencyPolicy => {
  const record = contractValidation.snapshotRecord(value, [
    'maximumConcurrentExecutions',
    'maximumConcurrentExecutionsPerExecutor',
  ]);
  const maximumConcurrentExecutions = contractValidation.boundedInteger(
    record['maximumConcurrentExecutions'],
    1,
    1_024,
  );
  const maximumConcurrentExecutionsPerExecutor = contractValidation.boundedInteger(
    record['maximumConcurrentExecutionsPerExecutor'],
    1,
    1_024,
  );
  if (maximumConcurrentExecutionsPerExecutor > maximumConcurrentExecutions) {
    throw new RangeError(
      'Per-executor concurrency must not exceed global process-local concurrency.',
    );
  }
  return Object.freeze({
    maximumConcurrentExecutions,
    maximumConcurrentExecutionsPerExecutor,
  });
};
