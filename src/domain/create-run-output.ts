import { snapshotRunOutputPayload } from '../policy/index.js';
import { domainValidation } from './domain-validation.js';
import type { RunOutput } from './run-output.js';
import { snapshotRunCorrelation } from './snapshot-run-correlation.js';

export const createRunOutput = (value: unknown): RunOutput => {
  const record = domainValidation.record(value);
  domainValidation.exactKeys(record, [
    'correlation',
    'createdAt',
    'id',
    'name',
    'payload',
    'runId',
  ]);
  return Object.freeze({
    correlation: snapshotRunCorrelation(domainValidation.required(record, 'correlation')),
    createdAt: domainValidation.nonnegativeInteger(record['createdAt']),
    id: domainValidation.boundedString(record['id']),
    name: domainValidation.boundedString(record['name']),
    payload: snapshotRunOutputPayload(domainValidation.required(record, 'payload')),
    runId: domainValidation.boundedString(record['runId']),
  });
};
