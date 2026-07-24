import type { JsonValue } from '../spec/index.js';
import { snapshotJsonValue } from './canonical-json/snapshot-json-value.js';
import { forEachArrayValue } from './for-each-array-value.js';

type JsonRecord = { readonly [key: string]: JsonValue };

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

const isJsonRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const copyPortableValue = (value: JsonValue): JsonValue => {
  if (isJsonArray(value)) {
    const copy: JsonValue[] = [];
    forEachArrayValue(value, (item) => {
      copy.push(copyPortableValue(item));
    });
    return Object.freeze(copy);
  }
  if (isJsonRecord(value)) {
    const copy: Record<string, JsonValue> = {};
    Object.setPrototypeOf(copy, null);
    forEachArrayValue(Object.keys(value), (key) => {
      const member = value[key];
      if (member === undefined) {
        throw new TypeError('Portable JSON snapshot contains an invalid record.');
      }
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: copyPortableValue(member),
        writable: true,
      });
    });
    return Object.freeze(copy);
  }
  return value;
};

export const snapshotPortableJsonValue = (value: unknown): JsonValue =>
  copyPortableValue(snapshotJsonValue(value));
