import type { RunFault, RunFaultCode } from '../errors/index.js';
import { snapshotRunFaultMessage } from '../policy/index.js';
import { domainValidation } from './domain-validation.js';

const faultCodes: readonly RunFaultCode[] = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'INVALID_STATE',
  'STALE_ACTIVATION',
  'REVISION_CONFLICT',
  'STALE_FENCE',
  'PLAN_UNAVAILABLE',
  'PLAN_MISMATCH',
  'EXECUTOR_UNAVAILABLE',
  'EXECUTOR_MISMATCH',
  'UNKNOWN_OUTCOME',
  'CANCELLED',
];

const isRunFaultCode = (value: unknown): value is RunFaultCode =>
  typeof value === 'string' && faultCodes.some((code) => code === value);

export const snapshotRunFault = (value: unknown): RunFault => {
  const record = domainValidation.record(value);
  domainValidation.exactKeys(record, ['code', 'message']);
  const code = domainValidation.required(record, 'code');
  if (!isRunFaultCode(code)) throw new TypeError('Run domain fault code is invalid.');
  return Object.freeze({
    code,
    message: snapshotRunFaultMessage(domainValidation.required(record, 'message')),
  });
};
