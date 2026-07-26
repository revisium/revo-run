import { snapshotPortableJsonValue } from '../policy/index.js';
import type { CanonicalJsonSha256Digest, JsonValue } from '../spec/index.js';

type JsonRecord = { readonly [key: string]: JsonValue };

const invalidInputMessage = 'Run domain input is invalid.';
const stringBoundMessage = 'Run domain string exceeds its fixed UTF-8 bound.';
const revisionOverflowMessage = 'Run domain revision exceeds the safe integer range.';

const isRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const assertWellFormedWithoutControls = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (
      codePoint === undefined ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      throw new TypeError(invalidInputMessage);
    }
    if (codePoint > 0xffff) index += 1;
  }
};

const boundedString = (value: JsonValue | undefined, maximumUtf8Bytes = 256): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(invalidInputMessage);
  assertWellFormedWithoutControls(value);
  if (Buffer.byteLength(value, 'utf8') > maximumUtf8Bytes) {
    throw new RangeError(stringBoundMessage);
  }
  return value;
};

const nonnegativeInteger = (value: JsonValue | undefined): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(invalidInputMessage);
  }
  if (value < 0) throw new RangeError(invalidInputMessage);
  return value;
};

const record = (value: unknown): JsonRecord => {
  const snapshot = snapshotPortableJsonValue(value);
  if (!isRecord(snapshot)) throw new TypeError(invalidInputMessage);
  return snapshot;
};

const required = (value: JsonRecord, key: string): JsonValue => {
  const member = value[key];
  if (member === undefined) throw new TypeError(invalidInputMessage);
  return member;
};

const exactKeys = (
  value: JsonRecord,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): void => {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) throw new TypeError(invalidInputMessage);
  if (requiredKeys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(invalidInputMessage);
  }
};

const incrementRevision = (revision: number): number => {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError(invalidInputMessage);
  if (revision === Number.MAX_SAFE_INTEGER) throw new RangeError(revisionOverflowMessage);
  return revision + 1;
};

const canonicalDigest = (value: JsonValue | undefined): CanonicalJsonSha256Digest => {
  const text = boundedString(value, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new TypeError(invalidInputMessage);
  return `sha256:${text.slice(7)}`;
};

export const domainValidation = Object.freeze({
  boundedString,
  canonicalDigest,
  exactKeys,
  incrementRevision,
  nonnegativeInteger,
  record,
  required,
});
