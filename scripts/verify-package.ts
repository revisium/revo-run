import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

assert.deepEqual(Object.keys(packageEntry), []);

await assert.rejects(
  import('@revisium/revo-run/dist/index.js'),
  (error) => error instanceof Error && 'code' in error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
);
`;

const typeConsumer = `
import * as packageEntry from '@revisium/revo-run';

const resolvedEntry: typeof packageEntry = packageEntry;
void resolvedEntry;
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
  await linkPackage(join(root, 'node_modules'), consumerNodeModules, '@types/node');

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
    `Exact tarball validation passed (${manifest.files.length} files; ATTW, contents, ESM, types, runtime/type deep-import denial).`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
