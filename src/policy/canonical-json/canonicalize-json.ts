import canonicalize from 'canonicalize';

import { snapshotJsonValue } from './snapshot-json-value.js';

export const canonicalizeJson = (value: unknown): string => {
  const result = canonicalize(snapshotJsonValue(value));
  if (result === undefined) {
    throw new TypeError('Canonical JSON serialization did not produce text.');
  }
  return result;
};
