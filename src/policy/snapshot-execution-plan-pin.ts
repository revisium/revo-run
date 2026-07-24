import type { ExecutionPlanPin } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';

export const snapshotExecutionPlanPin = (value: unknown): ExecutionPlanPin => {
  const record = contractValidation.snapshotRecord(value, ['digest', 'id', 'revision']);
  return Object.freeze({
    digest: contractValidation.boundedString(record['digest'], 256),
    id: contractValidation.boundedString(record['id'], 256),
    revision: contractValidation.boundedString(record['revision'], 256),
  });
};
