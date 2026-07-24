import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import { canonicalizeJson, digestCanonicalJson } from '../../src/policy/index.js';

const fixtureNames = [
  'official-sorting',
  'unicode-order',
  'escapes',
  'numbers',
  'array',
  'ordering',
] as const;

describe('canonical JSON RFC 8785 behavior', () => {
  test.each(fixtureNames)('matches the pinned %s byte and digest fixture', async (name) => {
    const fixture = new URL(`../fixtures/rfc8785/${name}/`, import.meta.url);
    const input: unknown = JSON.parse(await readFile(new URL('input.json', fixture), 'utf8'));
    const expectedHex = (await readFile(new URL('canonical.utf8.hex', fixture), 'utf8')).trim();
    const expectedDigest = (await readFile(new URL('sha256.txt', fixture), 'utf8')).trim();

    expect(Buffer.from(canonicalizeJson(input), 'utf8').toString('hex')).toBe(expectedHex);
    expect(digestCanonicalJson(input)).toBe(expectedDigest);
  });

  test('canonicalizes equivalent insertion orders to identical bytes and digests', () => {
    const first = { z: 1, a: { beta: 2 } };
    const second = { a: { beta: 2 }, z: 1 };

    expect(canonicalizeJson(first)).toBe('{"a":{"beta":2},"z":1}');
    expect(canonicalizeJson(second)).toBe(canonicalizeJson(first));
    expect(digestCanonicalJson(second)).toBe(digestCanonicalJson(first));
  });

  test('digests canonical UTF-8 bytes without a trailing newline', () => {
    expect(digestCanonicalJson({ a: 1 })).toBe(
      'sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
  });

  const appendixBNumbers = [
    {
      digest: 'sha256:5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9',
      ieee754: '0000000000000000',
      json: '0',
      purpose: 'zero',
    },
    {
      digest: 'sha256:5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9',
      ieee754: '8000000000000000',
      json: '0',
      purpose: 'minus zero',
    },
    {
      digest: 'sha256:c46e7ca1be4c8734f373a56530787288fa2058d73d07855e9247e949f811a42a',
      ieee754: '0000000000000001',
      json: '5e-324',
      purpose: 'minimum positive subnormal',
    },
    {
      digest: 'sha256:046f4049d09944fcb2efbf2ddb0ea8f05e0204591d6d02c9106efc88190fa7f9',
      ieee754: '8000000000000001',
      json: '-5e-324',
      purpose: 'minimum negative subnormal',
    },
    {
      digest: 'sha256:c2784e1abd6317452708f3fbf9641c16b959561bc621a1d408c23a20aa2cb585',
      ieee754: '7fefffffffffffff',
      json: '1.7976931348623157e+308',
      purpose: 'maximum finite positive number',
    },
    {
      digest: 'sha256:f0347276b171ff0c36491c912285a2833de7313d1a103a4b1be0274bfe7c021f',
      ieee754: 'ffefffffffffffff',
      json: '-1.7976931348623157e+308',
      purpose: 'maximum finite negative number',
    },
    {
      digest: 'sha256:c681da39d7273a6a24c15c9cac3a75526ff2ecf8ba4ee60346a0c70c8163bdb2',
      ieee754: '4340000000000000',
      json: '9007199254740992',
      purpose: 'maximum positive integer row',
    },
    {
      digest: 'sha256:83e109bfd7fb4984b47a46f363627c18dbbd7e57e36b05a04cd162d304df72e9',
      ieee754: 'c340000000000000',
      json: '-9007199254740992',
      purpose: 'maximum negative integer row',
    },
    {
      digest: 'sha256:7933ef1b34c194c7a327ef424e54282dd2872bc7bda27812f9edf7882ca340c0',
      ieee754: '4430000000000000',
      json: '295147905179352830000',
      purpose: 'approximately two to the power of 68',
    },
    {
      digest: 'sha256:143eadc1fc2fe10a563df313c717399d1835652d710fa189119ff2e1d5cde33d',
      ieee754: '44b52d02c7e14af5',
      json: '9.999999999999997e+22',
      purpose: 'lower exponent boundary neighbor',
    },
    {
      digest: 'sha256:0b1af6b73e932475817f8eb620deecf21ad7570df3400a23db5c79a9001597f7',
      ieee754: '44b52d02c7e14af6',
      json: '1e+23',
      purpose: 'exact exponent boundary',
    },
    {
      digest: 'sha256:de7cb5db5ee06bf7ef5b74ebcf94cd9d7efda28125905f7ff590724953173c7b',
      ieee754: '44b52d02c7e14af7',
      json: '1.0000000000000001e+23',
      purpose: 'upper exponent boundary neighbor',
    },
    {
      digest: 'sha256:dcabf7269f6bb6ec5ba8b9530825cd7ffe215d4dd26e0a237f9d753513792c07',
      ieee754: '444b1ae4d6e2ef4e',
      json: '999999999999999700000',
      purpose: 'lower one e21 boundary neighbor',
    },
    {
      digest: 'sha256:914b4f8b4bbe2f6e7c36ad7791fc842a7516d149e694b3a71b78cee465ff6d7a',
      ieee754: '444b1ae4d6e2ef4f',
      json: '999999999999999900000',
      purpose: 'nearest lower one e21 boundary neighbor',
    },
    {
      digest: 'sha256:241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c',
      ieee754: '444b1ae4d6e2ef50',
      json: '1e+21',
      purpose: 'one e21 exponent boundary',
    },
    {
      digest: 'sha256:2ace34b29d30d300aeacd4f2bb83367fa186f11a3f02ed461f35f00fd741a242',
      ieee754: '3eb0c6f7a0b5ed8c',
      json: '9.999999999999997e-7',
      purpose: 'lower one e-6 boundary neighbor',
    },
    {
      digest: 'sha256:159fb29a827ad04b260aa6c8ab6d8637f8f2b38af5c4f3cb49d6a21205e040f8',
      ieee754: '3eb0c6f7a0b5ed8d',
      json: '0.000001',
      purpose: 'one e-6 decimal boundary',
    },
    {
      digest: 'sha256:0fdb7bafaf219ccaf278cd0c0a580473db01c774a0baafe72a07d01230ac5c6d',
      ieee754: '41b3de4355555553',
      json: '333333333.3333332',
      purpose: 'shortest round-trip lower neighbor two',
    },
    {
      digest: 'sha256:bcbe1777b7d3c91c19c7f90100c595a9b3f1d9b395567da4258baf7ac655d403',
      ieee754: '41b3de4355555554',
      json: '333333333.33333325',
      purpose: 'shortest round-trip lower neighbor one',
    },
    {
      digest: 'sha256:6bd9be1c141028789cc35db62f1b43e80d5d4ee24d6d542e775deb16799ff4c7',
      ieee754: '41b3de4355555555',
      json: '333333333.3333333',
      purpose: 'shortest round-trip center',
    },
    {
      digest: 'sha256:1e099031ca0cb3cf4054688f7e2e8c95fc72828de5fa7605ce3f729e6cf79d43',
      ieee754: '41b3de4355555556',
      json: '333333333.3333334',
      purpose: 'shortest round-trip upper neighbor one',
    },
    {
      digest: 'sha256:cf68ab5e198a77538aafd967fb122a305ba1df95c9348b1fe3dff453c7f7215f',
      ieee754: '41b3de4355555557',
      json: '333333333.33333343',
      purpose: 'shortest round-trip upper neighbor two',
    },
    {
      digest: 'sha256:4e703d4e0928e4f339d03e1fb5454ddc33db657ad735b02530d98123b4fd4b61',
      ieee754: 'becbf647612f3696',
      json: '-0.0000033333333333333333',
      purpose: 'negative fractional number',
    },
    {
      digest: 'sha256:e1547479d27f057e3197d49417a1dcbe19dd8781b34fa9f83b789925943d00cb',
      ieee754: '43143ff3c1cb0959',
      json: '1424953923781206.2',
      purpose: 'round to even',
    },
  ] as const;

  test.each(appendixBNumbers)(
    'matches RFC 8785 Appendix B $purpose bytes and digest',
    ({ digest, ieee754, json }) => {
      const bytes = new ArrayBuffer(8);
      const view = new DataView(bytes);
      view.setBigUint64(0, BigInt(`0x${ieee754}`));
      const value = view.getFloat64(0);

      expect(canonicalizeJson(value)).toBe(json);
      expect(digestCanonicalJson(value)).toBe(digest);
    },
  );

  test.each([
    { ieee754: '7fffffffffffffff', purpose: 'NaN' },
    { ieee754: '7ff0000000000000', purpose: 'positive infinity' },
  ])('rejects RFC 8785 Appendix B $purpose row', ({ ieee754 }) => {
    const bytes = new ArrayBuffer(8);
    const view = new DataView(bytes);
    view.setBigUint64(0, BigInt(`0x${ieee754}`));
    const value = view.getFloat64(0);

    expect(() => canonicalizeJson(value)).toThrow(TypeError);
    expect(() => digestCanonicalJson(value)).toThrow(TypeError);
  });
});

describe('canonical JSON hostile-value isolation', () => {
  test('rejects unsupported primitives, non-finite numbers, and invalid Unicode', () => {
    for (const value of [
      undefined,
      1n,
      Symbol('value'),
      () => undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '\ud800',
      '\udc00',
      '\ud800x',
      'x\udc00',
      { '\ud800': 'value' },
      { '\udc00': 'value' },
      { toJSON: null },
    ]) {
      expect(() => canonicalizeJson(value)).toThrow(TypeError);
    }
  });

  test('rejects accessors and own toJSON without invoking user code', () => {
    let calls = 0;
    const getter = (): string => {
      calls += 1;
      return 'secret';
    };
    const objectAccessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: getter,
    });
    const arrayAccessor = Object.defineProperty([], '0', {
      enumerable: true,
      get: getter,
    });
    const ownToJson = Object.defineProperty({}, 'toJSON', {
      get: getter,
    });

    for (const value of [objectAccessor, arrayAccessor, ownToJson]) {
      expect(() => canonicalizeJson(value)).toThrow(TypeError);
    }
    expect(calls).toBe(0);
  });

  test('rejects custom records, non-enumerable properties, symbols, and custom arrays', () => {
    const customRecord: object = {};
    Object.setPrototypeOf(customRecord, { inherited: true });
    const hiddenRecord = Object.defineProperty({}, 'hidden', { value: true });
    const symbolRecord = { [Symbol('hidden')]: true };
    const sparseArray: unknown[] = [];
    sparseArray[1] = true;
    const customPropertyArray = Object.assign([], { extra: true });
    const hiddenPropertyArray = Object.defineProperty([], 'extra', { value: true });
    const customPrototypeArray: unknown[] = [];
    const customArrayPrototype: object = {};
    Object.setPrototypeOf(customArrayPrototype, Array.prototype);
    Object.setPrototypeOf(customPrototypeArray, customArrayPrototype);

    for (const value of [
      customRecord,
      hiddenRecord,
      symbolRecord,
      sparseArray,
      customPropertyArray,
      hiddenPropertyArray,
      customPrototypeArray,
    ]) {
      expect(() => canonicalizeJson(value)).toThrow(TypeError);
    }
  });

  test('ignores hostile inherited toJSON methods and snapshots __proto__ as data', () => {
    const objectPrototype: unknown = Object.getPrototypeOf({});
    const arrayPrototype: unknown = Object.getPrototypeOf([]);
    if (
      typeof objectPrototype !== 'object' ||
      objectPrototype === null ||
      typeof arrayPrototype !== 'object' ||
      arrayPrototype === null
    ) {
      throw new TypeError('Expected intrinsic object and array prototypes.');
    }
    const objectToJson = Object.getOwnPropertyDescriptor(objectPrototype, 'toJSON');
    const arrayToJson = Object.getOwnPropertyDescriptor(arrayPrototype, 'toJSON');
    let calls = 0;
    const hostileToJson = (): never => {
      calls += 1;
      throw new Error('must not run');
    };
    const record: Record<string, unknown> = {};
    Object.setPrototypeOf(record, null);
    Object.defineProperty(record, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { safe: true },
      writable: true,
    });

    Object.defineProperty(objectPrototype, 'toJSON', {
      configurable: true,
      value: hostileToJson,
    });
    Object.defineProperty(arrayPrototype, 'toJSON', {
      configurable: true,
      value: hostileToJson,
    });
    try {
      expect(canonicalizeJson({ object: { value: 1 }, array: [2, 3], record })).toBe(
        '{"array":[2,3],"object":{"value":1},"record":{"__proto__":{"safe":true}}}',
      );
      expect(calls).toBe(0);
    } finally {
      if (objectToJson) Object.defineProperty(objectPrototype, 'toJSON', objectToJson);
      else Reflect.deleteProperty(objectPrototype, 'toJSON');
      if (arrayToJson) Object.defineProperty(arrayPrototype, 'toJSON', arrayToJson);
      else Reflect.deleteProperty(arrayPrototype, 'toJSON');
    }
  });

  test('rejects cycles while allowing repeated acyclic references', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalizeJson(cycle)).toThrowError(
      new TypeError('Canonical JSON input must not contain cycles.'),
    );

    const shared = { value: 1 };
    expect(canonicalizeJson({ first: shared, second: shared })).toBe(
      '{"first":{"value":1},"second":{"value":1}}',
    );
  });

  test('uses fixed errors that do not retain hostile values', () => {
    const secret = 'secret-value-that-must-not-leak';
    let error: unknown;
    try {
      canonicalizeJson({ value: Symbol(secret) });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain(secret);
    expect(String(error).length).toBeLessThan(160);
  });
});

describe('canonical JSON fixed bounds', () => {
  const nestedArray = (depth: number): unknown => {
    let value: unknown = null;
    for (let index = 0; index < depth; index += 1) value = [value];
    return value;
  };

  test('accepts depth 64 and rejects depth 65', () => {
    expect(() => canonicalizeJson(nestedArray(64))).not.toThrow();
    expect(() => canonicalizeJson(nestedArray(65))).toThrowError(
      new RangeError('Canonical JSON input exceeds the maximum depth of 64.'),
    );
  });

  test('accepts 65,536 members and rejects 65,537 members', () => {
    expect(() => canonicalizeJson(Array.from({ length: 65_536 }, () => null))).not.toThrow();
    expect(() => canonicalizeJson(Array.from({ length: 65_537 }, () => null))).toThrowError(
      new RangeError('Canonical JSON input exceeds the maximum member count of 65536.'),
    );
  });

  test('accepts exactly 1 MiB and rejects one additional canonical UTF-8 byte', () => {
    expect(Buffer.byteLength(canonicalizeJson('x'.repeat(1_048_574)), 'utf8')).toBe(1_048_576);
    expect(() => canonicalizeJson('x'.repeat(1_048_575))).toThrowError(
      new RangeError('Canonical JSON input exceeds the maximum UTF-8 size of 1048576 bytes.'),
    );
  });
});
