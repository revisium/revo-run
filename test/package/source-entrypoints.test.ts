import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

import * as packageEntry from '../../src/index.js';
import * as canonicalJsonEntry from '../../src/policy/index.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

test('bootstrap entry point has no accidental public API', () => {
  expect(Object.keys(packageEntry)).toEqual([]);
});

test('canonical JSON has a curated semantic source surface', () => {
  expect(Object.keys(canonicalJsonEntry).sort()).toEqual([
    'canonicalizeJson',
    'digestCanonicalJson',
  ]);
  expect(canonicalJsonEntry.canonicalizeJson({ b: 1, a: 'value' })).toBe('{"a":"value","b":1}');
});

test('source entrypoint is exactly the empty module marker', async () => {
  expect(await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8')).toBe(
    'export {};\n',
  );
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
    description: 'Reusable durable multi-run manager for Revo.',
    homepage: 'https://github.com/revisium/revo-run#readme',
    type: 'module',
    dependencies: { canonicalize: '3.0.0' },
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
      './canonical-json': {
        types: './dist/policy/canonical-json/index.d.ts',
        import: './dist/policy/canonical-json/index.js',
      },
    },
  });
});
