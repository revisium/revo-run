import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'revo-run-package-'));
try {
  interface PackManifest {
    readonly filename: string;
    readonly files: readonly { readonly path: string }[];
  }
  const isPackManifest = (value: unknown): value is PackManifest =>
    typeof value === 'object' &&
    value !== null &&
    'filename' in value &&
    typeof value.filename === 'string' &&
    'files' in value &&
    Array.isArray(value.files) &&
    value.files.every(
      (file: unknown) =>
        typeof file === 'object' &&
        file !== null &&
        'path' in file &&
        typeof file.path === 'string',
    );
  const packValue: unknown = JSON.parse(
    execFileSync('pnpm', ['pack', '--json', '--pack-destination', temporary], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  const manifest: unknown = Array.isArray(packValue) ? packValue[0] : packValue;
  assert.ok(isPackManifest(manifest));
  const tarball = manifest.filename;
  execFileSync('attw', [tarball, '--profile', 'esm-only'], { stdio: 'inherit' });
  const paths = manifest.files.map((file) => file.path);
  assert(paths.includes('dist/index.js'));
  assert(paths.includes('dist/index.d.ts'));
  assert(
    !paths.some(
      (path) =>
        path.includes('canonical-json') ||
        path.startsWith('dist/domain/') ||
        path.startsWith('dist/storage/'),
    ),
  );

  const consumer = join(temporary, 'consumer');
  mkdirSync(join(consumer, 'node_modules', '@revisium', 'revo-run'), { recursive: true });
  execFileSync('tar', [
    '-xzf',
    tarball,
    '-C',
    join(consumer, 'node_modules', '@revisium', 'revo-run'),
    '--strip-components=1',
  ]);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: {
        '@dbos-inc/dbos-sdk': '4.25.14',
        '@revisium/revo-pipeline': '0.1.0-alpha.0',
        '@revisium/revo-run': `file:${tarball}`,
      },
    }),
  );
  execFileSync('pnpm', ['install', '--ignore-scripts'], { cwd: consumer, stdio: 'inherit' });
  const declaration = readFileSync(
    join(consumer, 'node_modules', '@revisium', 'revo-run', 'dist', 'index.d.ts'),
    'utf8',
  );
  for (const name of [
    'CreateRunManagerOptions',
    'RunManager',
    'ExecutionPlanPin',
    'RunSnapshot',
    'RunStatus',
    'RunPlanSource',
    'RunExecutor',
    'RunSnapshotStore',
    'JsonValue',
  ]) {
    assert.match(declaration, new RegExp(name));
  }
  for (const forbidden of [
    'RunManagerSnapshot',
    'RunIdSource',
    'canonicalize',
    'applicationName',
    'systemDatabaseUrl',
  ]) {
    assert.doesNotMatch(declaration, new RegExp(forbidden));
  }

  const packageSource = readFileSync(join(root, 'package.json'), 'utf8');
  assert.match(packageSource, /"exports":\s*\{\s*"\."\s*:/);
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', "import('@revisium/revo-run/manager')"],
      { cwd: consumer, stdio: 'pipe' },
    ),
  );
  const source = `import { createRunManager } from '@revisium/revo-run';\nimport type { CreateRunManagerOptions } from '@revisium/revo-run';\nexport const value: typeof createRunManager | CreateRunManagerOptions = createRunManager;\n`;
  mkdirSync(dirname(join(consumer, 'src', 'index.ts')), { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) =>
    Promise.all([
      writeFile(join(consumer, 'src', 'index.ts'), source),
      writeFile(
        join(consumer, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
          },
          include: ['src'],
        }),
      ),
    ]),
  );
  execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: consumer,
    stdio: 'inherit',
  });
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const module = await import('@revisium/revo-run');
if (Object.keys(module).join(',') !== 'createRunManager') { process.exit(1); }
const manager = module.createRunManager({
  database: { url: 'postgresql://test' },
  plans: { loadExact: async () => ({ compiledPipeline: null }) },
  executor: { execute: async () => ({ outcome: 'completed' }) },
  snapshots: {
    create: async () => undefined,
    update: async () => undefined,
    get: async () => undefined,
  },
});
if (Object.keys(manager).join(',') !== 'start,stop,startRun,getRun') { process.exit(1); }
if (!Object.isFrozen(manager)) { process.exit(1); }
if (Reflect.set(manager, 'state', 'started')) { process.exit(1); }
const start = manager.start;
if (typeof start !== 'function') { process.exit(1); }
await manager.stop();`,
    ],
    { cwd: consumer, stdio: 'inherit' },
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
