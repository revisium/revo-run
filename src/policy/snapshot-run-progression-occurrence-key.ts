import type { JsonValue } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';

const codePointCount = (value: string): number => {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if ((value.codePointAt(index) ?? 0) > 0xffff) index += 1;
    count += 1;
  }
  return count;
};

export const snapshotRunProgressionOccurrenceKey = (value: JsonValue | undefined): string => {
  const key = contractValidation.boundedString(value, 256);
  if (key !== key.normalize('NFC') || codePointCount(key) > 64) {
    throw new TypeError('Run progression occurrence key is invalid.');
  }
  return key;
};
