import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

import { canonicalizeJson, digestCanonicalJson } from '../../src/index.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

test('root entry point exposes only the durable JSON utilities', () => {
  expect(canonicalizeJson({ b: 1, a: 'value' })).toBe('{"a":"value","b":1}');
  expect(digestCanonicalJson({ a: 1 })).toBe(
    'sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
  );
});

test('production source has no pipeline or agent-runtime import', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/@revisium\/revo-(?:pipeline|agent-runtime)/);
});

test('package metadata declares the intended package and explicit root export', async () => {
  const rawPackageJson: unknown = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  );

  if (!isRecord(rawPackageJson)) {
    throw new TypeError('Expected package.json to contain an object');
  }

  const exports = isRecord(rawPackageJson.exports) ? rawPackageJson.exports : undefined;

  expect({
    name: rawPackageJson.name,
    version: rawPackageJson.version,
    description: rawPackageJson.description,
    homepage: rawPackageJson.homepage,
    type: rawPackageJson.type,
    dependencies: rawPackageJson.dependencies,
    exports,
  }).toEqual({
    name: '@revisium/revo-run',
    version: '0.0.0',
    description: 'Durable logical-attempt kernel for Revo.',
    homepage: 'https://github.com/revisium/revo-run#readme',
    type: 'module',
    dependencies: { canonicalize: '3.0.0' },
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    },
  });
});
