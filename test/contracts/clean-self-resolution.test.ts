import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { parse } from '@babel/parser';
import type { ImportDeclaration, Node } from '@babel/types';
import { describe, expect, it } from 'vitest';

type JsonRecord = Record<string, unknown>;

const rootFile = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown, label: string): JsonRecord => {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be a mapping.`);
  }
  return value;
};

const parseJsonRecord = (source: string, label: string): JsonRecord => {
  const value: unknown = JSON.parse(source);
  return requireRecord(value, label);
};

const verifyCommands = (script: unknown): string[] => {
  if (typeof script !== 'string' || /[;\n]|\|\||(?<!&)&(?!&)/u.test(script)) {
    throw new TypeError('verify must be one fail-fast AND command chain.');
  }
  return script.split(/\s*&&\s*/u);
};

const isRootImport = (node: Node): node is ImportDeclaration =>
  node.type === 'ImportDeclaration' && node.source.value === '@revisium/revo-run';

const assertCleanSelfResolution = ({
  buildConfigSource,
  consumerSource,
  manifestSource,
  typecheckConfigSource,
}: {
  buildConfigSource: string;
  consumerSource: string;
  manifestSource: string;
  typecheckConfigSource: string;
}): void => {
  const manifest = parseJsonRecord(manifestSource, 'package.json');
  const scripts = requireRecord(manifest['scripts'], 'package.json scripts');
  const expectedCommands = [
    'pnpm run format:check',
    'pnpm run build',
    'pnpm run typecheck',
    'pnpm run lint',
    'pnpm run test:cov',
    'pnpm run verify:shell',
    'pnpm run verify:package',
  ];
  if (!isDeepStrictEqual(verifyCommands(scripts['verify']), expectedCommands)) {
    throw new Error('verify must build dist before typechecking the root consumer fixture.');
  }

  expect(manifest['types']).toBe('./dist/index.d.ts');
  const exports = requireRecord(manifest['exports'], 'package.json exports');
  expect(Object.keys(exports)).toStrictEqual(['.']);
  expect(requireRecord(exports['.'], 'root export')['types']).toBe('./dist/index.d.ts');

  const buildConfig = parseJsonRecord(buildConfigSource, 'tsconfig.build.json');
  const buildOptions = requireRecord(buildConfig['compilerOptions'], 'build compiler options');
  expect(buildOptions).toMatchObject({ declaration: true, outDir: 'dist', rootDir: 'src' });
  expect(buildConfig['include']).toStrictEqual(['src/**/*.ts']);

  const typecheckConfig = parseJsonRecord(typecheckConfigSource, 'tsconfig.json');
  expect(typecheckConfig['include']).toContain('test/**/*.ts');

  const consumer = parse(consumerSource, { sourceType: 'module', plugins: ['typescript'] });
  const rootImports = consumer.program.body.filter(isRootImport);
  expect(rootImports).toHaveLength(1);
  expect(
    rootImports[0]?.specifiers.map((specifier) =>
      specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier'
        ? specifier.imported.name
        : undefined,
    ),
  ).toStrictEqual([
    'createRunManager',
    'AgentAttemptExecutionPort',
    'PipelineSourcePackage',
    'RunProfile',
  ]);
};

const sources = {
  buildConfigSource: rootFile('tsconfig.build.json'),
  consumerSource: rootFile('test/package/fixtures/root-consumer/raw-create-run.ts'),
  manifestSource: rootFile('package.json'),
  typecheckConfigSource: rootFile('tsconfig.json'),
};

describe('clean package self-resolution', () => {
  it('builds the declared root types before typechecking the root consumer fixture', () => {
    expect(() => assertCleanSelfResolution(sources)).not.toThrow();
  });

  it('rejects the clean-CI order that typechecks before creating dist', () => {
    const manifest = parseJsonRecord(sources.manifestSource, 'package.json');
    const scripts = requireRecord(manifest['scripts'], 'package.json scripts');
    const verify = scripts['verify'];
    if (typeof verify !== 'string') {
      throw new TypeError('verify script is missing.');
    }
    scripts['verify'] = verify.replace(
      'pnpm run build && pnpm run typecheck',
      'pnpm run typecheck && pnpm run build',
    );

    expect(() =>
      assertCleanSelfResolution({
        ...sources,
        manifestSource: JSON.stringify(manifest),
      }),
    ).toThrow('verify must build dist before typechecking the root consumer fixture.');
  });
});
