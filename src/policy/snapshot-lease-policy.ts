import type { LeasePolicy } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';

const maximumDurationMs = 86_400_000;

export const snapshotLeasePolicy = (value: unknown): LeasePolicy => {
  const record = contractValidation.snapshotRecord(value, [
    'heartbeatIntervalMs',
    'leaseDurationMs',
  ]);
  const heartbeatIntervalMs = contractValidation.boundedInteger(
    record['heartbeatIntervalMs'],
    100,
    maximumDurationMs,
  );
  const leaseDurationMs = contractValidation.boundedInteger(
    record['leaseDurationMs'],
    1_000,
    maximumDurationMs,
  );
  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new RangeError('Heartbeat interval must be strictly less than lease duration.');
  }
  return Object.freeze({ heartbeatIntervalMs, leaseDurationMs });
};
