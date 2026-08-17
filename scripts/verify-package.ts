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
        '@revisium/revo-pipeline': '0.1.0',
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
    'ExecutionPlan',
    'RunError',
    'RunErrorCode',
    'RunExecutor',
    'RunManager',
    'RunSnapshot',
    'RunStatus',
    'StartRunInput',
    'StartRunResult',
  ]) {
    assert.match(declaration, new RegExp(name));
  }
  for (const forbidden of [
    'RunManagerSnapshot',
    'RunIdSource',
    'ExecutionPlanPin',
    'RunPlanSource',
    'RunSnapshotStore',
    'canonicalize',
    'applicationName',
    'systemDatabaseUrl',
    'planPin',
    'taskInputs',
    'revision',
  ]) {
    assert.doesNotMatch(declaration, new RegExp(forbidden));
  }
  const packageRoot = join(consumer, 'node_modules', '@revisium', 'revo-run');
  const declarations = paths
    .filter((path) => path.endsWith('.d.ts'))
    .map((path) => readFileSync(join(packageRoot, path), 'utf8'))
    .join('\n');
  assert.match(declarations, /type ExecutionPlan = PipelineExecutionTemplate/);
  assert.doesNotMatch(declarations, /@dbos-inc|DBOSConfig/);
  assert.doesNotMatch(
    declaration,
    /ExecutionInvocation|ExecutionResult|ReconcileResult|CancelResult/,
  );

  const packageSource = readFileSync(join(root, 'package.json'), 'utf8');
  assert.match(packageSource, /"exports":\s*\{\s*"\."\s*:/);
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', "import('@revisium/revo-run/manager')"],
      { cwd: consumer, stdio: 'pipe' },
    ),
  );
  const source = `import { compilePipeline, definePipeline } from '@revisium/revo-pipeline';
import { createRunManager } from '@revisium/revo-run';
import type { CreateRunManagerOptions, ExecutionPlan, RunExecutor, RunSnapshot } from '@revisium/revo-run';

const compilation = compilePipeline(definePipeline({
  schemaVersion: 1,
  entry: 'done',
  facts: [],
  nodes: [{ kind: 'terminal', key: 'done', outcome: 'succeeded' }],
}));
if (!compilation.ok) throw new Error('consumer fixture failed');
const executionPlan: ExecutionPlan = compilation.template;
const executor: RunExecutor = {
  cancel: async () => ({ status: 'not_supported' }),
  execute: async () => ({ status: 'completed', completion: { kind: 'task' } }),
  reconcile: async () => ({ status: 'not_found' }),
};
const options: CreateRunManagerOptions = { database: { url: 'postgresql://test' }, executor };

export const createConsumer = () => {
  const manager = createRunManager(options);
  const startRun = (runId: string) => manager.startRun({ executionPlan, input: null, runId });
  const getDates = async (runId: string): Promise<readonly Date[] | undefined> => {
    const snapshot: RunSnapshot | undefined = await manager.getRun(runId);
    return snapshot === undefined ? undefined : [snapshot.createdAt, snapshot.updatedAt];
  };
  return { getDates, manager, startRun };
};
`;
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
  executor: {
    cancel: async () => ({ status: 'not_supported' }),
    execute: async () => ({ status: 'completed', completion: { kind: 'task' } }),
    reconcile: async () => ({ status: 'not_found' }),
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
