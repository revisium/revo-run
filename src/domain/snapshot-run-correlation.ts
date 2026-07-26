import { domainValidation } from './domain-validation.js';
import type { RunCorrelation } from './run-correlation.js';

export const snapshotRunCorrelation = (value: unknown): RunCorrelation => {
  const record = domainValidation.record(value);
  const kind = domainValidation.required(record, 'kind');
  if (kind === 'run') {
    domainValidation.exactKeys(record, ['kind']);
    return Object.freeze({ kind });
  }
  if (kind === 'node') {
    domainValidation.exactKeys(record, ['activationId', 'kind', 'nodeInstanceId']);
    return Object.freeze({
      activationId: domainValidation.boundedString(record['activationId']),
      kind,
      nodeInstanceId: domainValidation.boundedString(record['nodeInstanceId']),
    });
  }
  if (kind === 'attempt') {
    domainValidation.exactKeys(record, ['activationId', 'attemptId', 'kind', 'nodeInstanceId']);
    return Object.freeze({
      activationId: domainValidation.boundedString(record['activationId']),
      attemptId: domainValidation.boundedString(record['attemptId']),
      kind,
      nodeInstanceId: domainValidation.boundedString(record['nodeInstanceId']),
    });
  }
  throw new TypeError('Run correlation kind is invalid.');
};
