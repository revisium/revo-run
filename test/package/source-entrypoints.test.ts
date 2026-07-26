import { readFile } from 'node:fs/promises';

import { expect, expectTypeOf, test } from 'vitest';

import * as packageEntry from '../../src/index.js';
import type {
  ExecutionPlanPin,
  ExecutorContractPin,
  RunArtifactReference,
  RunConflict,
  RunExecutionPlanDocument,
  RunFault,
  RunOutputPayload,
} from '../../src/index.js';
import * as policyEntry from '../../src/policy/index.js';
import * as portsEntry from '../../src/ports/index.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

test('bootstrap entry point has no accidental public API', () => {
  expect(Object.keys(packageEntry)).toEqual([]);
});

test('policy has a curated source surface', () => {
  expect(Object.keys(policyEntry).sort()).toEqual([
    'canonicalizeJson',
    'digestCanonicalJson',
    'snapshotExecutionPlanPin',
    'snapshotExecutorAttemptReference',
    'snapshotExecutorConfiguration',
    'snapshotExecutorContractPin',
    'snapshotExecutorInvocationSnapshot',
    'snapshotExecutorOutput',
    'snapshotExecutorOutputs',
    'snapshotLeasePolicy',
    'snapshotPortableJsonValue',
    'snapshotProcessLocalConcurrencyPolicy',
    'snapshotRetryPolicy',
    'snapshotRunArtifactReference',
    'snapshotRunExecutionPlanDocument',
    'snapshotRunExecutionPlanExecutorBinding',
    'snapshotRunFaultMessage',
    'snapshotRunOutputPayload',
    'snapshotTimeoutPolicy',
    'verifyExecutorBinding',
  ]);
  expect(policyEntry.canonicalizeJson({ b: 1, a: 'value' })).toBe('{"a":"value","b":1}');
});

test('package-private executor ports are type-only', () => {
  expect(Object.keys(portsEntry)).toEqual([]);
});

test('source root is type-only and does not promise a manager implementation', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  expect(source).toContain('export type {');
  expect(source).not.toContain('createRunManager');
  expect(source).not.toMatch(/export\s+(?:const|function|class)\s/);
});

test('root type surface is package-owned and provider-neutral', () => {
  expectTypeOf<ExecutionPlanPin>().toHaveProperty('digest');
  expectTypeOf<ExecutorContractPin>().toHaveProperty('adapterId');
  expectTypeOf<RunExecutionPlanDocument['compiledPipeline']>().not.toBeFunction();
  expectTypeOf<keyof RunArtifactReference>().toEqualTypeOf<
    'artifactId' | 'bytes' | 'mediaType' | 'sha256'
  >();
  expectTypeOf<RunOutputPayload['kind']>().toEqualTypeOf<'artifact' | 'json'>();
  expectTypeOf<RunFault['code']>().not.toEqualTypeOf<string>();
  expectTypeOf<RunConflict['code']>().not.toEqualTypeOf<string>();
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
