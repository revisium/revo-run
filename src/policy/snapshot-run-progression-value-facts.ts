import { contractValidation } from './contract-validation.js';
import { forEachArrayValue } from './for-each-array-value.js';
import { snapshotPortableJsonValue } from './snapshot-portable-json-value.js';

export const snapshotRunProgressionValueFacts = (
  value: unknown,
): readonly { readonly key: string; readonly value: null | boolean | number | string }[] => {
  const source = contractValidation.array(snapshotPortableJsonValue(value), 4_096);
  const facts: { readonly key: string; readonly value: null | boolean | number | string }[] = [];
  const keys = new Set<string>();
  forEachArrayValue(source, (candidate) => {
    const record = contractValidation.record(candidate, ['key', 'value']);
    const key = contractValidation.boundedString(record['key'], 256);
    const factValue = record['value'];
    if (
      !(
        factValue === null ||
        typeof factValue === 'boolean' ||
        typeof factValue === 'string' ||
        (typeof factValue === 'number' && Number.isFinite(factValue))
      ) ||
      keys.has(key)
    ) {
      throw new TypeError('Run progression value facts are invalid.');
    }
    keys.add(key);
    facts.push(Object.freeze({ key, value: factValue }));
  });
  return Object.freeze(facts);
};
