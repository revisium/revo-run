import { describe, expect, it } from 'vitest';

import { snapshotRunInput } from '../../src/manager/snapshot-run-input.js';

const objectWithInheritedState = (): object => {
  const value = {};
  Object.setPrototypeOf(value, { inherited: true });
  return value;
};

describe('JSON boundary snapshots', () => {
  it('accepts finite structural JSON and detaches nested values', () => {
    const source = { array: [null, true, 1, 'value'], nested: { value: 1 } };

    const snapshot = snapshotRunInput(source);
    source.array[3] = 'changed';
    source.nested.value = 2;

    expect(snapshot).toEqual({
      array: [null, true, 1, 'value'],
      nested: { value: 1 },
    });
  });

  it('accepts null-prototype records and preserves special own string keys safely', () => {
    const source: Record<string, unknown> = {};
    Object.setPrototypeOf(source, null);
    source['constructor'] = 'own';
    source['__proto__'] = { safe: true };

    const snapshot = snapshotRunInput(source);

    expect(snapshot).toEqual({ constructor: 'own', ['__proto__']: { safe: true } });
    if (typeof snapshot !== 'object' || snapshot === null) {
      throw new Error('Snapshot is not an object.');
    }
    expect(Object.hasOwn(snapshot, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(({} as { safe?: boolean }).safe).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['non-finite number', Number.POSITIVE_INFINITY],
    ['function', () => true],
    ['symbol', Symbol('value')],
    ['bigint', 1n],
    [
      'class instance',
      new (class Value {
        readonly value = true;
      })(),
    ],
    ['custom inherited state', objectWithInheritedState()],
    ['sparse array', Object.assign(new Array<unknown>(2), { 0: 'present' })],
    ['augmented array', Object.assign([1], { extra: true })],
  ])('rejects %s', (_name, value) => {
    expect(() => snapshotRunInput(value)).toThrow('JSON-safe');
  });

  it('rejects cycles', () => {
    const source: { cycle?: unknown } = {};
    source.cycle = source;

    expect(() => snapshotRunInput(source)).toThrow('JSON-safe');
  });

  it('rejects symbol and non-enumerable keys', () => {
    const symbolKey = { value: true, [Symbol('hidden')]: true };
    const hidden = { value: true };
    Object.defineProperty(hidden, 'hidden', { value: true });

    expect(() => snapshotRunInput(symbolKey)).toThrow('JSON-safe');
    expect(() => snapshotRunInput(hidden)).toThrow('JSON-safe');
  });

  it('rejects object and array accessors without invoking them', () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'secret';
      },
    });
    const arrayAccessor: unknown[] = [];
    Object.defineProperty(arrayAccessor, '0', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'secret';
      },
    });

    expect(() => snapshotRunInput(accessor)).toThrow('JSON-safe');
    expect(() => snapshotRunInput(arrayAccessor)).toThrow('JSON-safe');
    expect(getterCalls).toBe(0);
  });
});
