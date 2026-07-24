import type { JsonValue } from '../spec/index.js';
import { forEachArrayValue } from './for-each-array-value.js';
import { snapshotPortableJsonValue } from './snapshot-portable-json-value.js';

type JsonRecord = { readonly [key: string]: JsonValue };

const invalidInputMessage = 'Portable contract input is invalid.';
const stringBoundMessage = 'Portable contract string exceeds its fixed UTF-8 bound.';
const collectionBoundMessage = 'Portable contract collection exceeds its fixed bound.';
const policyRangeMessage = 'Portable policy value is outside its fixed range.';

const isRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isJsonArray = (value: JsonValue | undefined): value is readonly JsonValue[] =>
  Array.isArray(value);

const assertExactKeys = (
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) {
    throw new TypeError(invalidInputMessage);
  }

  const allowed = new Set<string>();
  forEachArrayValue(required, (key) => allowed.add(key));
  forEachArrayValue(optional, (key) => allowed.add(key));
  forEachArrayValue(keys, (key) => {
    if (!allowed.has(key)) throw new TypeError(invalidInputMessage);
  });
  forEachArrayValue(required, (key) => {
    if (!Object.hasOwn(value, key)) throw new TypeError(invalidInputMessage);
  });
};

const assertWellFormedWithoutControls = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new TypeError(invalidInputMessage);
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      throw new TypeError(invalidInputMessage);
    }
    if (codePoint > 0xffff) {
      index += 1;
    }
  }
};

const boundedString = (value: JsonValue | undefined, maximumUtf8Bytes: number): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(invalidInputMessage);
  assertWellFormedWithoutControls(value);
  if (Buffer.byteLength(value, 'utf8') > maximumUtf8Bytes) {
    throw new RangeError(stringBoundMessage);
  }
  return value;
};

const boundedInteger = (value: JsonValue | undefined, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(invalidInputMessage);
  }
  if (value < minimum || value > maximum) throw new RangeError(policyRangeMessage);
  return value;
};

const record = (
  value: JsonValue,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonRecord => {
  if (!isRecord(value)) throw new TypeError(invalidInputMessage);
  assertExactKeys(value, required, optional);
  return value;
};

const snapshotRecord = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonRecord => record(snapshotPortableJsonValue(value), required, optional);

const array = (value: JsonValue | undefined, maximumItems: number): readonly JsonValue[] => {
  if (!isJsonArray(value)) throw new TypeError(invalidInputMessage);
  if (value.length > maximumItems) throw new RangeError(collectionBoundMessage);
  return value;
};

const requiredValue = (value: JsonRecord, key: string): JsonValue => {
  const member = value[key];
  if (member === undefined) throw new TypeError(invalidInputMessage);
  return member;
};

const booleanWithDefault = (value: JsonValue | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') throw new TypeError(invalidInputMessage);
  return value;
};

const mediaType = (value: JsonValue | undefined): string => {
  const text = boundedString(value, 127);
  if (
    text.length < 3 ||
    !/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+\/[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(text)
  ) {
    throw new TypeError(invalidInputMessage);
  }
  return text;
};

const sha256Hex = (value: JsonValue | undefined): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(invalidInputMessage);
  }
  return value;
};

export const contractValidation = Object.freeze({
  array,
  booleanWithDefault,
  boundedInteger,
  boundedString,
  mediaType,
  record,
  requiredValue,
  sha256Hex,
  snapshotRecord,
});
