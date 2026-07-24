import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

import { canonicalizeJson, digestCanonicalJson, validateArtifactRefV1 } from '../../src/index.js';

const fixtureNames = ['unicode-order', 'escapes', 'numbers', 'array', 'ordering'] as const;

test.each(fixtureNames)('matches the pinned RFC 8785 %s byte and digest fixture', async (name) => {
  const fixture = new URL(`../fixtures/rfc8785/${name}/`, import.meta.url);
  const input = JSON.parse(await readFile(new URL('input.json', fixture), 'utf8')) as unknown;
  const expectedHex = (await readFile(new URL('canonical.utf8.hex', fixture), 'utf8')).trim();
  const expectedDigest = (await readFile(new URL('sha256.txt', fixture), 'utf8')).trim();

  expect(Buffer.from(canonicalizeJson(input), 'utf8').toString('hex')).toBe(expectedHex);
  expect(digestCanonicalJson(input)).toBe(expectedDigest);
});

test('canonicalizes equivalent object values into RFC 8785 JSON', () => {
  expect(canonicalizeJson({ z: [true, null], a: { b: 2 } })).toBe('{"a":{"b":2},"z":[true,null]}');
});

test('canonicalizes equivalent insertion orders to the same pinned digest', () => {
  expect(digestCanonicalJson({ z: 1, a: { beta: 2 } })).toBe(
    digestCanonicalJson({ a: { beta: 2 }, z: 1 }),
  );
});

test('digests canonical UTF-8 JSON without a trailing newline', () => {
  expect(digestCanonicalJson({ a: 1 })).toBe(
    'sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
  );
});

test('rejects unsupported durable JSON values', () => {
  const sparse: unknown[] = [];
  sparse[1] = 'value';

  for (const value of [
    undefined,
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    sparse,
    { value: undefined },
    '\ud800',
  ]) {
    expect(() => canonicalizeJson(value)).toThrow(TypeError);
  }
});

test('rejects accessors, symbols, and cycles before canonicalization', () => {
  const accessor = Object.defineProperty({}, 'value', { get: () => 'secret', enumerable: true });
  const symbolKey = { [Symbol('value')]: 'secret' };
  const arrayAccessor = Object.defineProperty([], '0', { get: () => 'secret', enumerable: true });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;

  for (const value of [accessor, symbolKey, arrayAccessor, { toJSON: null }, cycle]) {
    expect(() => canonicalizeJson(value)).toThrow(TypeError);
  }
});

test('uses a safe deep snapshot when Object and Array prototypes are polluted', () => {
  const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let calls = 0;
  const hostileToJson = (): never => {
    calls += 1;
    throw new Error('must not be called');
  };

  Reflect.defineProperty(Object.prototype, 'toJSON', { configurable: true, value: hostileToJson });
  Reflect.defineProperty(Array.prototype, 'toJSON', { configurable: true, value: hostileToJson });
  try {
    expect(canonicalizeJson({ object: { value: 1 }, array: [2, 3] })).toBe(
      '{"array":[2,3],"object":{"value":1}}',
    );
    expect(calls).toBe(0);
  } finally {
    if (objectToJson) Reflect.defineProperty(Object.prototype, 'toJSON', objectToJson);
    else Reflect.deleteProperty(Object.prototype, 'toJSON');
    if (arrayToJson) Reflect.defineProperty(Array.prototype, 'toJSON', arrayToJson);
    else Reflect.deleteProperty(Array.prototype, 'toJSON');
  }
});

test('rejects an own toJSON accessor without invoking it', () => {
  let calls = 0;
  const value = Object.defineProperty({}, 'toJSON', {
    configurable: true,
    get: () => {
      calls += 1;
      return () => undefined;
    },
  });

  expect(() => canonicalizeJson(value)).toThrow(TypeError);
  expect(calls).toBe(0);
});

const externalArtifact = (locator: object | null, immutableRevision: string | null): object => ({
  bytes: 1,
  contentDigest: null,
  immutableRevision,
  inline: null,
  locator,
  mediaType: 'application/json',
  mode: 'external',
  retentionClass: 'run',
  schemaVersion: 'revo-run/artifact-ref/v1',
});

const expectLocatorError = (value: object, path: string, rule: string, secret?: string): void => {
  const result = validateArtifactRefV1(value);
  expect(result).toMatchObject({ ok: false, error: { path, retryable: false, rule } });
  if (!result.ok && secret) expect(result.error.message).not.toContain(secret);
};

test('accepts each closed immutable external locator form', () => {
  const commit = 'a'.repeat(40);
  const examples = [
    externalArtifact({ kind: 'git-commit', repositoryId: 'repo_1', commit }, `git:${commit}`),
    externalArtifact(
      { kind: 'github-commit', repositoryId: 'repo_1', commit },
      `github:repo_1@${commit}`,
    ),
    externalArtifact(
      { kind: 'revisium-revision', projectId: 'project_1', revisionId: 'revision_1' },
      'revisium:project_1@revision_1',
    ),
  ];

  for (const example of examples)
    expect(validateArtifactRefV1(example)).toMatchObject({ ok: true });
});

test('rejects closed-locator unknown fields at their exact pointers', () => {
  expect.hasAssertions();
  const commit = 'a'.repeat(40);
  expectLocatorError(
    externalArtifact(
      { kind: 'git-commit', repositoryId: 'repo', commit, path: '/tmp/x' },
      `git:${commit}`,
    ),
    '/locator/path',
    'unknown_field',
  );
  for (const field of [
    'url',
    'uri',
    'host',
    'query',
    'headers',
    'token',
    'credentials',
    'providerConfig',
    'ref',
    'branch',
    'filePath',
  ]) {
    expectLocatorError(
      externalArtifact(
        { kind: 'git-commit', repositoryId: 'repo', commit, [field]: 'value' },
        `git:${commit}`,
      ),
      `/locator/${field}`,
      'unknown_field',
    );
  }
});

test('rejects forbidden coordinates without retaining the supplied value', () => {
  expect.hasAssertions();
  const commit = 'a'.repeat(40);
  for (const identifier of [
    '/tmp/x',
    '../x',
    'C:\\x',
    'file:///etc/passwd',
    'https://token@example.test/a',
    'ssh://user@example.test/a',
    'repo@token',
    'repo%2Ftoken',
  ]) {
    expectLocatorError(
      externalArtifact({ kind: 'git-commit', repositoryId: identifier, commit }, `git:${commit}`),
      '/locator/repositoryId',
      'locator_forbidden_coordinate',
      identifier,
    );
  }
});

test('rejects mutable commits and incompatible artifact mode combinations', () => {
  expect.hasAssertions();
  for (const commit of ['main', 'v1', 'abcdef0', 'A'.repeat(40)]) {
    expectLocatorError(
      externalArtifact({ kind: 'git-commit', repositoryId: 'repo', commit }, 'git:irrelevant'),
      '/locator/commit',
      'locator_commit_invalid',
    );
  }
  const validCommit = 'a'.repeat(40);
  expectLocatorError(
    externalArtifact(
      { kind: 'git-commit', repositoryId: 'repo', commit: validCommit },
      'not-derived',
    ),
    '/immutableRevision',
    'locator_revision_mismatch',
  );
  const inline = {
    ...externalArtifact(null, null),
    inline: { value: 1 },
    locator: { kind: 'git-commit', repositoryId: 'repo', commit: validCommit },
    mode: 'inline',
  };
  expectLocatorError(inline, '/locator', 'artifact_mode_invariant');
});

test('enforces the closed root schema and common artifact fields', () => {
  expect.hasAssertions();
  const commit = 'a'.repeat(40);
  const valid = externalArtifact(
    { kind: 'git-commit', repositoryId: 'repo', commit },
    `git:${commit}`,
  );
  expectLocatorError(
    { ...valid, token: 'secret-value' },
    '/token',
    'unknown_field',
    'secret-value',
  );
  expectLocatorError(
    { ...valid, schemaVersion: 'revo-run/artifact-ref/v2' },
    '/schemaVersion',
    'schema_version_invalid',
  );
  expectLocatorError(
    { ...valid, mediaType: 'text/plain; charset=utf-8' },
    '/mediaType',
    'media_type_invalid',
  );
  expectLocatorError({ ...valid, contentDigest: 'sha256:ABC' }, '/contentDigest', 'sha256_invalid');
  expectLocatorError({ ...valid, bytes: -1 }, '/bytes', 'safe_int_invalid');
  expectLocatorError(
    { ...valid, retentionClass: 'forever' },
    '/retentionClass',
    'retention_class_invalid',
  );
});

test('accepts precise inline and content-addressed matrices', () => {
  const inline = { result: ['value'] };
  const inlineValue = {
    bytes: Buffer.byteLength(canonicalizeJson(inline), 'utf8'),
    contentDigest: digestCanonicalJson(inline),
    immutableRevision: null,
    inline,
    locator: null,
    mediaType: 'application/json',
    mode: 'inline',
    retentionClass: 'run',
    schemaVersion: 'revo-run/artifact-ref/v1',
  };
  const contentAddressed = {
    bytes: 9,
    contentDigest: `sha256:${'a'.repeat(64)}`,
    immutableRevision: null,
    inline: null,
    locator: null,
    mediaType: 'application/octet-stream',
    mode: 'content-addressed',
    retentionClass: 'retained',
    schemaVersion: 'revo-run/artifact-ref/v1',
  };
  expect(validateArtifactRefV1(inlineValue)).toMatchObject({ ok: true });
  expect(validateArtifactRefV1(contentAddressed)).toMatchObject({ ok: true });
});

test('enforces the exact 65,536-byte canonical inline boundary before digest persistence', () => {
  const atLimit = 'x'.repeat(65_534);
  const overLimit = 'x'.repeat(65_535);
  const inlineArtifact = (inline: string): object => ({
    bytes: Buffer.byteLength(canonicalizeJson(inline), 'utf8'),
    contentDigest: digestCanonicalJson(inline),
    immutableRevision: null,
    inline,
    locator: null,
    mediaType: 'application/json',
    mode: 'inline',
    retentionClass: 'run',
    schemaVersion: 'revo-run/artifact-ref/v1',
  });

  expect(Buffer.byteLength(canonicalizeJson(atLimit), 'utf8')).toBe(65_536);
  expect(validateArtifactRefV1(inlineArtifact(atLimit))).toMatchObject({ ok: true });
  expect(Buffer.byteLength(canonicalizeJson(overLimit), 'utf8')).toBe(65_537);
  expectLocatorError(inlineArtifact(overLimit), '/inline', 'inline_bytes_exceeded');
});

test('rejects every invalid artifact mode combination', () => {
  expect.hasAssertions();
  const inline = { value: 1 };
  const inlineBase = {
    bytes: Buffer.byteLength(canonicalizeJson(inline), 'utf8'),
    contentDigest: digestCanonicalJson(inline),
    immutableRevision: null,
    inline,
    locator: null,
    mediaType: 'application/json',
    mode: 'inline',
    retentionClass: 'run',
    schemaVersion: 'revo-run/artifact-ref/v1',
  };
  expectLocatorError({ ...inlineBase, bytes: 0 }, '/bytes', 'artifact_mode_invariant');
  expectLocatorError({ ...inlineBase, contentDigest: null }, '/inline', 'artifact_mode_invariant');
  expectLocatorError({ ...inlineBase, inline: null }, '/inline', 'artifact_mode_invariant');
  expectLocatorError(
    { ...inlineBase, locator: { kind: 'git-commit' } },
    '/locator',
    'artifact_mode_invariant',
  );

  const contentBase = {
    ...inlineBase,
    inline: null,
    mode: 'content-addressed',
  };
  expectLocatorError(
    { ...contentBase, contentDigest: null },
    '/contentDigest',
    'artifact_mode_invariant',
  );
  expectLocatorError({ ...contentBase, bytes: null }, '/contentDigest', 'artifact_mode_invariant');
  expectLocatorError({ ...contentBase, inline }, '/inline', 'artifact_mode_invariant');
  expectLocatorError(
    { ...contentBase, immutableRevision: 'git:main' },
    '/immutableRevision',
    'artifact_mode_invariant',
  );

  expectLocatorError(
    { ...externalArtifact(null, null), locator: null },
    '/locator',
    'external_locator_required',
  );
  expectLocatorError(
    {
      ...externalArtifact(
        { kind: 'git-commit', repositoryId: 'repo', commit: 'a'.repeat(40) },
        null,
      ),
    },
    '/immutableRevision',
    'external_locator_required',
  );
  expectLocatorError(
    {
      ...externalArtifact(
        { kind: 'git-commit', repositoryId: 'repo', commit: 'a'.repeat(40) },
        `git:${'a'.repeat(40)}`,
      ),
      inline,
    },
    '/inline',
    'artifact_mode_invariant',
  );
});
