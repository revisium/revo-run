import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface PackFile {
  readonly path: string;
}

interface PackManifest {
  readonly filename: string;
  readonly files: readonly PackFile[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const commandOutputText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
};

const commandFailureOutput = (error: unknown): string => {
  if (!isRecord(error)) {
    return String(error);
  }
  return `${commandOutputText(error['stdout'])}${commandOutputText(error['stderr'])}`;
};

const declarationModuleSpecifiers = (source: string): readonly string[] =>
  [
    ...source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g),
  ].flatMap((match) => (match[1] ? [match[1]] : []));

const declarationReferences = (source: string): readonly string[] =>
  declarationModuleSpecifiers(source).filter((specifier) => specifier.startsWith('.'));

const declarationTarget = (from: string, specifier: string): string => {
  const target = join(dirname(from), specifier);
  if (target.endsWith('.js')) return `${target.slice(0, -3)}.d.ts`;
  if (target.endsWith('.d.ts')) return target;
  return `${target}.d.ts`;
};

const readReachableDeclarations = (entry: string): string => {
  const pending = [entry];
  const visited = new Set<string>();
  const declarations: string[] = [];

  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);

    const source = readFileSync(path, 'utf8');
    declarations.push(source);
    pending.push(
      ...declarationReferences(source).map((specifier) => declarationTarget(path, specifier)),
    );
  }

  return declarations.join('\n');
};

const isPackManifest = (value: unknown): value is PackManifest =>
  isRecord(value) &&
  typeof value.filename === 'string' &&
  Array.isArray(value.files) &&
  value.files.every((file: unknown) => isRecord(file) && typeof file.path === 'string');

const packagePath = (root: string, packageName: string): string =>
  join(root, ...packageName.split('/'));

const linkPackage = async (
  sourceNodeModules: string,
  targetNodeModules: string,
  packageName: string,
): Promise<void> => {
  const target = packagePath(targetNodeModules, packageName);
  await mkdir(dirname(target), { recursive: true });
  await symlink(packagePath(sourceNodeModules, packageName), target, 'dir');
};

const validateContents = (manifest: PackManifest): void => {
  const paths = manifest.files.map((file) => file.path).sort();
  const requiredPaths = [
    'LICENSE',
    'README.md',
    'dist/index.d.ts',
    'dist/index.d.ts.map',
    'dist/index.js',
    'dist/index.js.map',
    'dist/policy/canonical-json/index.d.ts',
    'dist/policy/canonical-json/index.d.ts.map',
    'dist/policy/canonical-json/index.js',
    'dist/policy/canonical-json/index.js.map',
    'package.json',
  ];

  for (const requiredPath of requiredPaths) {
    assert.ok(paths.includes(requiredPath), `Package is missing ${requiredPath}`);
  }

  const unexpectedPaths = paths.filter(
    (path) =>
      !['LICENSE', 'README.md', 'package.json'].includes(path) &&
      !/^dist\/.*\.(?:d\.ts|d\.ts\.map|js|js\.map)$/.test(path),
  );

  assert.deepEqual(unexpectedPaths, [], `Unexpected package files: ${unexpectedPaths.join(', ')}`);
};

const runtimeConsumer = `
import assert from 'node:assert/strict';

import * as packageEntry from '@revisium/revo-run';
import { canonicalizeJson, digestCanonicalJson } from '@revisium/revo-run/canonical-json';

assert.deepEqual(Object.keys(packageEntry), []);
assert.equal(canonicalizeJson({ b: 1, a: 'value' }), '{"a":"value","b":1}');
assert.equal(
  digestCanonicalJson({ a: 1 }),
  'sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
);

await assert.rejects(
  import('@revisium/revo-run/dist/index.js'),
  (error) => error instanceof Error && 'code' in error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
);
`;

const typeConsumer = `
import * as packageEntry from '@revisium/revo-run';
import {
  canonicalizeJson,
  digestCanonicalJson,
  type CanonicalJsonSha256Digest,
  type JsonValue,
} from '@revisium/revo-run/canonical-json';

const resolvedEntry: typeof packageEntry = packageEntry;
const value: JsonValue = { nested: [true, null, 1, 'value'] };
const digest: CanonicalJsonSha256Digest = digestCanonicalJson(value);
const canonical: string = canonicalizeJson(value);
void resolvedEntry;
void digest;
void canonical;
`;

const privateTypeConsumer = `
import * as privateEntry from '@revisium/revo-run/dist/index.js';

void privateEntry;
`;

const consumerTsconfig = {
  compilerOptions: {
    target: 'ES2024',
    lib: ['ES2024'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    moduleDetection: 'force',
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: false,
    types: ['node'],
  },
  include: ['consumer.ts'],
};

const privateConsumerTsconfig = {
  ...consumerTsconfig,
  include: ['private-consumer.ts'],
};

assert.deepEqual(
  declarationModuleSpecifiers(`
import 'side-effect-package';
import type canonicalize from 'canonicalize';
export type InlineCrypto = typeof import('node:crypto');
import crypto = require('node:crypto');
`),
  ['side-effect-package', 'canonicalize', 'node:crypto', 'node:crypto'],
  'Declaration module-specifier scan must cover imports, inline imports, and import-equals require',
);

const root = process.cwd();
const temporaryRoot = await mkdtemp(join(tmpdir(), 'revo-run-package-'));
const packDirectory = join(temporaryRoot, 'package');
const consumerDirectory = join(temporaryRoot, 'consumer');
const consumerNodeModules = join(consumerDirectory, 'node_modules');

try {
  await mkdir(packDirectory);
  await mkdir(consumerDirectory);

  const packOutput = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: join(temporaryRoot, 'npm-cache'),
        npm_config_loglevel: 'silent',
      },
    },
  );
  const parsedPackOutput: unknown = JSON.parse(packOutput);
  assert.ok(Array.isArray(parsedPackOutput) && parsedPackOutput.length === 1);
  const manifest: unknown = parsedPackOutput[0];
  assert.ok(isPackManifest(manifest));

  const tarball = join(packDirectory, manifest.filename);
  execFileSync('attw', [tarball, '--profile', 'esm-only'], { stdio: 'inherit' });
  validateContents(manifest);

  const installedPackage = packagePath(consumerNodeModules, '@revisium/revo-run');
  await mkdir(installedPackage, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', installedPackage, '--strip-components=1']);
  assert.equal(
    await readFile(join(installedPackage, 'dist/index.d.ts'), 'utf8'),
    'export {};\n//# sourceMappingURL=index.d.ts.map',
    'Packed declaration must contain only the empty-module marker and its source-map directive',
  );
  const canonicalJsonDeclaration = await readFile(
    join(installedPackage, 'dist/policy/canonical-json/index.d.ts'),
    'utf8',
  );
  assert.match(canonicalJsonDeclaration, /canonicalizeJson/);
  assert.match(canonicalJsonDeclaration, /digestCanonicalJson/);
  assert.match(canonicalJsonDeclaration, /CanonicalJsonSha256Digest/);
  assert.match(canonicalJsonDeclaration, /JsonValue/);
  assert.doesNotMatch(canonicalJsonDeclaration, /ArtifactRef|ExecutionPlan|RunManager/);
  const reachableCanonicalJsonDeclarations = readReachableDeclarations(
    join(installedPackage, 'dist/policy/canonical-json/index.d.ts'),
  );
  assert.deepEqual(
    declarationModuleSpecifiers(reachableCanonicalJsonDeclarations).filter(
      (specifier) => specifier === 'canonicalize' || specifier === 'node:crypto',
    ),
    [],
    'Packed canonical JSON declaration module specifiers must exclude runtime dependencies',
  );
  await linkPackage(join(root, 'node_modules'), consumerNodeModules, '@types/node');
  await linkPackage(join(root, 'node_modules'), consumerNodeModules, 'canonicalize');

  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, undefined, 2)}\n`,
  );
  await writeFile(join(consumerDirectory, 'consumer.mjs'), runtimeConsumer);
  await writeFile(join(consumerDirectory, 'consumer.ts'), typeConsumer);
  await writeFile(join(consumerDirectory, 'private-consumer.ts'), privateTypeConsumer);
  await writeFile(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(consumerTsconfig, undefined, 2)}\n`,
  );
  await writeFile(
    join(consumerDirectory, 'tsconfig.private.json'),
    `${JSON.stringify(privateConsumerTsconfig, undefined, 2)}\n`,
  );

  execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], {
    cwd: consumerDirectory,
    stdio: 'pipe',
  });
  assert.throws(
    () =>
      execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.private.json'], {
        cwd: consumerDirectory,
        stdio: 'pipe',
      }),
    (error: unknown) => commandFailureOutput(error).includes('TS2307'),
    'TypeScript must reject a private package deep import with TS2307',
  );
  execFileSync(process.execPath, ['consumer.mjs'], {
    cwd: consumerDirectory,
    stdio: 'pipe',
  });

  console.log(
    `Exact tarball validation passed (${manifest.files.length} files; ATTW, contents, ESM, types, reachable declaration isolation, runtime/type deep-import denial).`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
