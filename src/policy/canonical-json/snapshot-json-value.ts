import type { JsonValue } from '../../spec/index.js';

const maximumDepth = 64;
const maximumMembers = 65_536;
const maximumUtf8Bytes = 1_048_576;

const invalidValueMessage = 'Canonical JSON input must contain only supported JSON values.';
const invalidRecordMessage = 'Canonical JSON objects must be plain records.';
const invalidPropertyMessage = 'Canonical JSON input must use enumerable data properties only.';
const invalidArrayMessage = 'Canonical JSON arrays must be dense and unmodified.';
const invalidUnicodeMessage = 'Canonical JSON strings must contain valid Unicode scalar values.';
const cycleMessage = 'Canonical JSON input must not contain cycles.';

interface SnapshotState {
  members: number;
  utf8Bytes: number;
}

interface EncodedCharacter {
  codeUnits: number;
  utf8Bytes: number;
}

const safeArrayPrototype: object = {};
Object.setPrototypeOf(safeArrayPrototype, null);
Object.defineProperty(safeArrayPrototype, 'map', {
  configurable: false,
  enumerable: false,
  value: Array.prototype.map,
  writable: false,
});
Object.freeze(safeArrayPrototype);

const consumeBytes = (state: SnapshotState, bytes: number): void => {
  state.utf8Bytes += bytes;
  if (state.utf8Bytes > maximumUtf8Bytes) {
    throw new RangeError('Canonical JSON input exceeds the maximum UTF-8 size of 1048576 bytes.');
  }
};

const consumeMember = (state: SnapshotState): void => {
  state.members += 1;
  if (state.members > maximumMembers) {
    throw new RangeError('Canonical JSON input exceeds the maximum member count of 65536.');
  }
};

const escapedControlByteLength = (codeUnit: number): number => {
  switch (codeUnit) {
    case 0x08:
    case 0x09:
    case 0x0a:
    case 0x0c:
    case 0x0d:
      return 2;
    default:
      return 6;
  }
};

const encodedCharacterAt = (value: string, index: number): EncodedCharacter => {
  const codeUnit = value.charCodeAt(index);
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
    const nextCodeUnit = value.charCodeAt(index + 1);
    if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
      throw new TypeError(invalidUnicodeMessage);
    }
    return { codeUnits: 2, utf8Bytes: 4 };
  }
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
    throw new TypeError(invalidUnicodeMessage);
  }
  if (codeUnit < 0x20) {
    return { codeUnits: 1, utf8Bytes: escapedControlByteLength(codeUnit) };
  }
  if (codeUnit === 0x22 || codeUnit === 0x5c) return { codeUnits: 1, utf8Bytes: 2 };
  if (codeUnit <= 0x7f) return { codeUnits: 1, utf8Bytes: 1 };
  if (codeUnit <= 0x7ff) return { codeUnits: 1, utf8Bytes: 2 };
  return { codeUnits: 1, utf8Bytes: 3 };
};

const canonicalStringByteLength = (value: string): number => {
  let bytes = 2;
  let index = 0;
  while (index < value.length) {
    const character = encodedCharacterAt(value, index);
    bytes += character.utf8Bytes;
    index += character.codeUnits;
  }
  return bytes;
};

const snapshotString = (value: string, state: SnapshotState): string => {
  consumeBytes(state, canonicalStringByteLength(value));
  return value;
};

const isArrayValue = (value: object): value is unknown[] => Array.isArray(value);

const isArrayIndex = (key: string): boolean => {
  if (key.length === 0) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
};

const snapshotArray = (
  value: unknown[],
  depth: number,
  ancestors: WeakSet<object>,
  state: SnapshotState,
): readonly JsonValue[] => {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(invalidArrayMessage);
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (key !== 'length' && !isArrayIndex(key))) {
      throw new TypeError(invalidArrayMessage);
    }
  }

  consumeBytes(state, 2);
  const snapshot: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(invalidArrayMessage);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(invalidPropertyMessage);
    }

    if (index > 0) consumeBytes(state, 1);
    consumeMember(state);
    const descriptorValue: unknown = descriptor.value;
    const item = snapshotValue(descriptorValue, depth + 1, ancestors, state);
    Object.defineProperty(snapshot, String(index), {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  Object.setPrototypeOf(snapshot, safeArrayPrototype);
  return Object.freeze(snapshot);
};

const snapshotRecord = (
  value: object,
  depth: number,
  ancestors: WeakSet<object>,
  state: SnapshotState,
): { readonly [key: string]: JsonValue } => {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(invalidRecordMessage);
  }

  consumeBytes(state, 2);
  const snapshot: Record<string, JsonValue> = {};
  Object.setPrototypeOf(snapshot, null);
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string' || key === 'toJSON') {
      throw new TypeError(invalidPropertyMessage);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(invalidPropertyMessage);
    }

    if (index > 0) consumeBytes(state, 1);
    consumeMember(state);
    consumeBytes(state, canonicalStringByteLength(key) + 1);
    const descriptorValue: unknown = descriptor.value;
    const propertyValue = snapshotValue(descriptorValue, depth + 1, ancestors, state);
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: propertyValue,
      writable: true,
    });
  }
  return Object.freeze(snapshot);
};

const snapshotObject = (
  value: object,
  depth: number,
  ancestors: WeakSet<object>,
  state: SnapshotState,
): JsonValue => {
  if (ancestors.has(value)) throw new TypeError(cycleMessage);
  ancestors.add(value);
  try {
    return isArrayValue(value)
      ? snapshotArray(value, depth, ancestors, state)
      : snapshotRecord(value, depth, ancestors, state);
  } finally {
    ancestors.delete(value);
  }
};

const snapshotValue = (
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
  state: SnapshotState,
): JsonValue => {
  if (depth > maximumDepth) {
    throw new RangeError('Canonical JSON input exceeds the maximum depth of 64.');
  }
  if (value === null) {
    consumeBytes(state, 4);
    return value;
  }
  if (typeof value === 'boolean') {
    consumeBytes(state, value ? 4 : 5);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(invalidValueMessage);
    consumeBytes(state, String(value).length);
    return value;
  }
  if (typeof value === 'string') return snapshotString(value, state);
  if (typeof value !== 'object') throw new TypeError(invalidValueMessage);
  return snapshotObject(value, depth, ancestors, state);
};

export const snapshotJsonValue = (value: unknown): JsonValue =>
  snapshotValue(value, 0, new WeakSet<object>(), { members: 0, utf8Bytes: 0 });
