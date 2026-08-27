import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { assertRegistryDependencyFiles } from './registry-dependency-contract.ts';

const isRecord = (value) => typeof value === 'object' && value !== null;

const packagePath = (root, packageName) => join(root, ...packageName.split('/'));

const linkPackage = async (sourceNodeModules, targetNodeModules, packageName) => {
  const target = packagePath(targetNodeModules, packageName);
  await mkdir(dirname(target), { recursive: true });
  await symlink(packagePath(sourceNodeModules, packageName), target, 'dir');
};

const assertPackedProductionHasNoTestHooks = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      assert.ok(!/(?:^|[/\\])test(?:[/\\]|$)/u.test(path), `Packed test path: ${path}`);
      await assertPackedProductionHasNoTestHooks(path);
      continue;
    }
    if (!entry.isFile() || !/\.(?:js|d\.ts)$/u.test(entry.name)) {
      continue;
    }
    const content = await readFile(path, 'utf8');
    assert.doesNotMatch(
      content,
      /Symbol\.for\(|globalThis\[|test[-_ ]?(?:fault|hook|marker)/iu,
      `Packed production artifact contains a test hook or marker: ${path}`,
    );
    assert.doesNotMatch(
      content,
      /WorkflowProbe|reachWorkflowProbe|\.probe(?:\?\.)?\.reach/u,
      `Packed production artifact contains a workflow probe: ${path}`,
    );
  }
};

const runtimeConsumer = `
import assert from 'node:assert/strict';
import { createRunManager } from '@revisium/revo-run';

const manager = createRunManager({
  database: { url: 'postgresql://example.invalid/revo-run' },
  host: {
    resources: { inspect: async () => undefined },
    workspaces: {
      inspect: async () => undefined,
      acquire: async () => { throw new Error('The packed consumer never starts a run.'); },
    },
    credentials: {
      inspect: async () => undefined,
      acquire: async () => { throw new Error('The packed consumer never starts a run.'); },
    },
  },
});
assert.equal(typeof manager.createRun, 'function');
await assert.rejects(
  import('@revisium/revo-run/dist/manager/create-run-manager.js'),
  (error) => error instanceof Error && 'code' in error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
);
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

const root = process.cwd();
const typeConsumer = await readFile(
  join(root, 'test/package/fixtures/root-consumer/raw-create-run.ts'),
  'utf8',
);
const temporaryRoot = await mkdtemp(join(tmpdir(), 'revo-run-packed-consumer-'));
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
  const parsedPackOutput = JSON.parse(packOutput);
  assert.ok(Array.isArray(parsedPackOutput) && parsedPackOutput.length === 1);
  const packResult = parsedPackOutput[0];
  assert.ok(isRecord(packResult) && typeof packResult.filename === 'string');
  const tarball = join(packDirectory, packResult.filename);
  const installedPackage = packagePath(consumerNodeModules, '@revisium/revo-run');
  await mkdir(installedPackage, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', installedPackage, '--strip-components=1']);
  await assertPackedProductionHasNoTestHooks(installedPackage);

  const manifestSource = await readFile(join(root, 'package.json'), 'utf8');
  assertRegistryDependencyFiles({
    manifestSource,
    lockfileSource: await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'),
    workspaceSource: await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'),
  });
  const packageJson = JSON.parse(manifestSource);
  assert.ok(isRecord(packageJson) && isRecord(packageJson.dependencies));
  const dependencies = Object.keys(packageJson.dependencies);
  await Promise.all(
    [...dependencies, '@types/node'].map(
      async (packageName) =>
        await linkPackage(join(root, 'node_modules'), consumerNodeModules, packageName),
    ),
  );
  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, undefined, 2)}\n`,
  );
  await writeFile(join(consumerDirectory, 'consumer.mjs'), runtimeConsumer);
  await writeFile(join(consumerDirectory, 'consumer.ts'), typeConsumer);
  await writeFile(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(consumerTsconfig, undefined, 2)}\n`,
  );

  execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], {
    cwd: consumerDirectory,
    stdio: 'pipe',
  });
  execFileSync(process.execPath, ['consumer.mjs'], { cwd: consumerDirectory, stdio: 'pipe' });
  console.log('Packed root consumer validation passed.');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
