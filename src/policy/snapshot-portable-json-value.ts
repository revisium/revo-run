import type { JsonValue } from '../spec/index.js';
import { snapshotJsonValue } from './canonical-json/snapshot-json-value.js';

type JsonRecord = { readonly [key: string]: JsonValue };

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

const isJsonRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const copyPortableValue = (value: JsonValue): JsonValue => {
  if (isJsonArray(value)) {
    const copy: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (item === undefined) {
        throw new TypeError('Portable JSON snapshot contains an invalid array.');
      }
      copy.push(copyPortableValue(item));
    }
    return Object.freeze(copy);
  }
  if (isJsonRecord(value)) {
    const copy: Record<string, JsonValue> = {};
    Object.setPrototypeOf(copy, null);
    for (const key of Object.keys(value)) {
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
    }
    return Object.freeze(copy);
  }
  return value;
};

export const snapshotPortableJsonValue = (value: unknown): JsonValue =>
  copyPortableValue(snapshotJsonValue(value));
