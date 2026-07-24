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

assert.deepEqual(Object.keys(packageEntry).sort(), ['canonicalizeJson', 'digestCanonicalJson', 'validateArtifactRefV1']);
assert.equal(packageEntry.canonicalizeJson({ b: 1, a: 'value' }), '{"a":"value","b":1}');
assert.equal(
  packageEntry.digestCanonicalJson({ a: 1 }),
  'sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
);
assert.equal(
  Buffer.from(packageEntry.canonicalizeJson({ '😀': 'grin', '€': 'euro', 'ö': 'diaeresis', '\\u0080': 'control' }), 'utf8').toString('hex'),
  '7b22c280223a22636f6e74726f6c222c22c3b6223a22646961657265736973222c22e282ac223a226575726f222c22f09f9880223a226772696e227d',
);

const priorToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
let pollutionCalls = 0;
Object.defineProperty(Object.prototype, 'toJSON', {
  configurable: true,
  value: () => { pollutionCalls += 1; throw new Error('must not run'); },
});
try {
  assert.equal(packageEntry.canonicalizeJson({ value: 1 }), '{"value":1}');
assert.equal(pollutionCalls, 0);
} finally {
  if (priorToJson) Object.defineProperty(Object.prototype, 'toJSON', priorToJson);
  else Reflect.deleteProperty(Object.prototype, 'toJSON');
}
assert.equal(
  packageEntry.validateArtifactRefV1({
    bytes: 1,
    contentDigest: null,
    immutableRevision: 'git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    inline: null,
    locator: { kind: 'git-commit', repositoryId: 'repo_1', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    mediaType: 'application/json',
    mode: 'external',
    retentionClass: 'run',
    schemaVersion: 'revo-run/artifact-ref/v1',
  }).ok,
  true,
);

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
  const manifest: unknown = Array.isArray(parsedPackOutput)
    ? parsedPackOutput[0]
    : isRecord(parsedPackOutput)
      ? Object.values(parsedPackOutput)[0]
      : undefined;
  assert.ok(isPackManifest(manifest));

  const tarball = join(packDirectory, manifest.filename);
  execFileSync('attw', [tarball, '--profile', 'esm-only'], { stdio: 'inherit' });
  validateContents(manifest);

  const installedPackage = packagePath(consumerNodeModules, '@revisium/revo-run');
  await mkdir(installedPackage, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', installedPackage, '--strip-components=1']);
  assert.match(
    await readFile(join(installedPackage, 'dist/index.d.ts'), 'utf8'),
    /export declare const digestCanonicalJson:/,
    'Packed declaration must include the public digest utility',
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
    `Exact tarball validation passed (${manifest.files.length} files; ATTW, contents, ESM, types, runtime/type deep-import denial).`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
