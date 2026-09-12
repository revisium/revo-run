import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const root = process.cwd();
const temporaryRoot = await mkdtemp(join(tmpdir(), 'revo-run-package-'));
const packDirectory = join(temporaryRoot, 'package');
const consumerDirectory = join(temporaryRoot, 'consumer');

try {
  await mkdir(packDirectory);
  await mkdir(consumerDirectory);

  const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: join(temporaryRoot, 'npm-cache'),
      npm_config_loglevel: 'silent',
    },
  });
  const jsonStart = packOutput.lastIndexOf('\n[');
  const packed: unknown = JSON.parse(packOutput.slice(jsonStart < 0 ? 0 : jsonStart + 1));
  if (!Array.isArray(packed) || packed.length !== 1 || !isRecord(packed[0])) {
    throw new Error('npm pack returned an unexpected result.');
  }
  const filename = packed[0]['filename'];
  if (typeof filename !== 'string') {
    throw new Error('npm pack did not return a tarball filename.');
  }
  const tarball = join(packDirectory, filename);

  execFileSync(
    join(root, 'node_modules/.bin/publint'),
    ['run', tarball, '--strict', '--pack=false'],
    {
      stdio: 'inherit',
    },
  );
  execFileSync(join(root, 'node_modules/.bin/attw'), [tarball, '--profile', 'esm-only'], {
    stdio: 'inherit',
  });

  const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const packageManager = isRecord(manifest) ? manifest['packageManager'] : undefined;
  if (typeof packageManager !== 'string') {
    throw new Error('package.json has no packageManager.');
  }
  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module', packageManager })}\n`,
  );
  await cp(
    join(root, 'test/package/fixtures/root-consumer/runtime.ts'),
    join(consumerDirectory, 'runtime.ts'),
  );
  await cp(
    join(root, 'test/package/fixtures/root-consumer/raw-create-run.ts'),
    join(consumerDirectory, 'consumer.ts'),
  );
  await writeFile(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        lib: ['ES2024'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        outDir: '.build',
        types: ['node'],
      },
      include: ['consumer.ts', 'runtime.ts'],
    })}\n`,
  );

  execFileSync('corepack', ['pnpm', 'add', '--prefer-offline', '--ignore-scripts', tarball], {
    cwd: consumerDirectory,
    stdio: 'inherit',
  });
  execFileSync(
    'corepack',
    ['pnpm', 'add', '--prefer-offline', '--ignore-scripts', '--save-dev', '@types/node@24.13.3'],
    { cwd: consumerDirectory, stdio: 'inherit' },
  );
  execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], {
    cwd: consumerDirectory,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['.build/runtime.js'], {
    cwd: consumerDirectory,
    env: process.env,
    stdio: 'inherit',
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
