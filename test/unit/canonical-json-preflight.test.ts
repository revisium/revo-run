import { beforeEach, expect, test, vi } from 'vitest';

const canonicalizeDependency = vi.hoisted(() => vi.fn<(value: unknown) => string | undefined>());

vi.mock('canonicalize', () => ({ default: canonicalizeDependency }));

import { canonicalizeJson } from '../../src/policy/index.js';

const expectRecursivelyFrozen = (value: unknown): void => {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) {
      const descriptorValue: unknown = descriptor.value;
      expectRecursivelyFrozen(descriptorValue);
    }
  }
};

const ownDataProperty = (value: object, key: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

beforeEach(() => {
  canonicalizeDependency.mockReset();
});

test('checks depth, member, and UTF-8 bounds before invoking the canonicalizer', () => {
  let deepValue: unknown = null;
  for (let depth = 0; depth < 65; depth += 1) deepValue = [deepValue];

  for (const value of [
    deepValue,
    Array.from({ length: 65_537 }, () => null),
    'x'.repeat(1_048_575),
  ]) {
    expect(() => canonicalizeJson(value)).toThrow(RangeError);
  }
  expect(canonicalizeDependency).not.toHaveBeenCalled();
});

test('invokes the dependency only with the completed safe snapshot', () => {
  const input = { array: [{ value: 1 }], record: { nested: true } };
  let dependencyInput: unknown;
  canonicalizeDependency.mockImplementation((value) => {
    dependencyInput = value;
    expect(value).not.toBe(input);
    expect(value).toEqual(input);
    expectRecursivelyFrozen(value);

    if (value === null || typeof value !== 'object') {
      throw new TypeError('Expected the dependency input to be a frozen record.');
    }
    const snapshotArray = ownDataProperty(value, 'array');
    const snapshotRecord = ownDataProperty(value, 'record');
    expect(snapshotArray).not.toBe(input.array);
    expect(snapshotRecord).not.toBe(input.record);
    if (!Array.isArray(snapshotArray)) {
      throw new TypeError('Expected the dependency input to contain a frozen array.');
    }
    expect(ownDataProperty(snapshotArray, 0)).not.toBe(input.array[0]);
    return '{"array":[{"value":1}],"record":{"nested":true}}';
  });

  expect(canonicalizeJson(input)).toBe('{"array":[{"value":1}],"record":{"nested":true}}');
  expect(canonicalizeDependency).toHaveBeenCalledOnce();

  if (dependencyInput === null || typeof dependencyInput !== 'object') {
    throw new TypeError('Expected the dependency input to be a frozen record.');
  }
  const snapshotArray = ownDataProperty(dependencyInput, 'array');
  if (!Array.isArray(snapshotArray)) {
    throw new TypeError('Expected the dependency input to contain a frozen array.');
  }
  const safeArrayPrototype: unknown = Object.getPrototypeOf(snapshotArray);
  expect(safeArrayPrototype).not.toBe(Array.prototype);
  expect(Object.isFrozen(safeArrayPrototype)).toBe(true);

  input.array[0]!.value = 2;
  input.record.nested = false;
  expect(dependencyInput).toEqual({ array: [{ value: 1 }], record: { nested: true } });
});
