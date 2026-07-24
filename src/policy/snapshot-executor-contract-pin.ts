import type { ExecutorContractPin } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';

export const snapshotExecutorContractPin = (value: unknown): ExecutorContractPin => {
  const record = contractValidation.snapshotRecord(value, ['adapterId', 'digest', 'revision']);
  return Object.freeze({
    adapterId: contractValidation.boundedString(record['adapterId'], 256),
    digest: contractValidation.boundedString(record['digest'], 256),
    revision: contractValidation.boundedString(record['revision'], 256),
  });
};
