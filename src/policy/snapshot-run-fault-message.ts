import type { RunFaultMessage } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';

export const snapshotRunFaultMessage = (value: unknown): RunFaultMessage => {
  const record = contractValidation.snapshotRecord({ value }, ['value']);
  return contractValidation.boundedString(record['value'], 512);
};
