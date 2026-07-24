import { contractValidation } from './contract-validation.js';

export const snapshotRunFaultMessage = (value: unknown): string => {
  const record = contractValidation.snapshotRecord({ value }, ['value']);
  return contractValidation.boundedString(record['value'], 512);
};
