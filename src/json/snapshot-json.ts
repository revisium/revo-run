import type { JsonValue } from '@revisium/revo-pipeline';

const invalidJson = (label: string): never => {
  throw new TypeError(`${label} must be JSON-safe.`);
};

const rejectInheritedEnumerableState = (value: object, label: string): void => {
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      invalidJson(label);
    }
  }
};

const ownDataValue = (value: object, key: string, label: string): unknown => {
  if (!Object.hasOwn(value, key)) {
    return invalidJson(label);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    return invalidJson(label);
  }
  return descriptor.value;
};

const snapshotArray = (
  value: readonly unknown[],
  label: string,
  ancestors: WeakSet<object>,
): JsonValue => {
  if (Object.getPrototypeOf(value) !== Array.prototype || ancestors.has(value)) {
    return invalidJson(label);
  }
  rejectInheritedEnumerableState(value, label);
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    keys.some((key) => typeof key === 'symbol') ||
    keys.length !== lengthDescriptor.value + 1
  ) {
    return invalidJson(label);
  }
  const length = lengthDescriptor.value;

  ancestors.add(value);
  try {
    const snapshot: JsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      const member = ownDataValue(value, key, label);
      snapshot.push(snapshotJson(member, label, ancestors));
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
};

const snapshotObject = (value: object, label: string, ancestors: WeakSet<object>): JsonValue => {
  const prototype: unknown = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || ancestors.has(value)) {
    return invalidJson(label);
  }
  rejectInheritedEnumerableState(value, label);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) {
    return invalidJson(label);
  }

  ancestors.add(value);
  try {
    const snapshot: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (typeof key !== 'string') {
        return invalidJson(label);
      }
      const member = snapshotJson(ownDataValue(value, key, label), label, ancestors);
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: member,
        writable: true,
      });
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
};

const snapshotJson = (value: unknown, label: string, ancestors: WeakSet<object>): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : invalidJson(label);
  }
  if (Array.isArray(value)) {
    return snapshotArray(value, label, ancestors);
  }
  if (typeof value === 'object') {
    return snapshotObject(value, label, ancestors);
  }
  return invalidJson(label);
};

export const snapshotJsonValue = (value: unknown, label: string): JsonValue =>
  snapshotJson(value, label, new WeakSet());
