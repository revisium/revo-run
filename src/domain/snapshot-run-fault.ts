import type { RunFault, RunFaultCode } from '../errors/index.js';
import { snapshotRunFaultMessage } from '../policy/index.js';
import { domainValidation } from './domain-validation.js';

const faultCodes = Object.freeze({
  CANCELLED: true,
  EXECUTOR_MISMATCH: true,
  EXECUTOR_UNAVAILABLE: true,
  INVALID_INPUT: true,
  INVALID_STATE: true,
  NOT_FOUND: true,
  PLAN_MISMATCH: true,
  PLAN_UNAVAILABLE: true,
  REVISION_CONFLICT: true,
  STALE_ACTIVATION: true,
  STALE_FENCE: true,
  UNKNOWN_OUTCOME: true,
});

const isRunFaultCode = (value: unknown): value is RunFaultCode =>
  typeof value === 'string' && Object.hasOwn(faultCodes, value);

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
