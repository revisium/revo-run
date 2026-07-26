import type { ExecutorOutput } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { snapshotRunOutputPayload } from './snapshot-run-output-payload.js';

export const snapshotExecutorOutput = (value: unknown): ExecutorOutput => {
  const record = contractValidation.snapshotRecord(value, ['name', 'payload']);
  return Object.freeze({
    name: contractValidation.boundedString(record['name'], 256),
    payload: snapshotRunOutputPayload(record['payload']),
  });
};
