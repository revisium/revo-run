import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'revo-run-smoke-'));
const environment = {
  ...process.env,
  NO_COLOR: '1',
  npm_config_cache: join(temporaryRoot, 'npm-cache'),
};

const loadDotEnv = (path) => {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (environment[key] === undefined) {
      environment[key] = value;
    }
  }
};

loadDotEnv(join(repositoryRoot, '.env.test'));
if (environment.DATABASE_URL === undefined) {
  throw new Error('DATABASE_URL is required to execute the packed consumer.');
}

const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const nodeTypes = manifest.devDependencies?.['@types/node'];
if (typeof nodeTypes !== 'string' || nodeTypes.length === 0) {
  throw new Error('package.json is missing a pinned @types/node devDependency.');
}

/** @param {string} command @param {readonly string[]} arguments_ @param {string} [cwd] */
const run = (command, arguments_, cwd = repositoryRoot) => {
  const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8', env: environment });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(' ')} failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result;
};

/** @param {string} directory */
const soleTarball = (directory) => {
  const tarballs = readdirSync(directory)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => join(directory, name));
  if (tarballs.length !== 1 || tarballs[0] === undefined) {
    throw new Error(`Expected one tarball in ${directory}.`);
  }
  return tarballs[0];
};

try {
  rmSync(join(repositoryRoot, 'dist'), { recursive: true, force: true });
  const packRoot = join(temporaryRoot, 'package');
  mkdirSync(packRoot);
  run('npm', ['pack', '--pack-destination', packRoot]);
  const tarball = soleTarball(packRoot);

  const entries = run('tar', ['-tzf', tarball]).stdout.trim().split(/\r?\n/u);
  const files = entries.filter((path) => !path.endsWith('/'));
  for (const required of [
    'package/LICENSE',
    'package/README.md',
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.d.ts',
  ]) {
    if (!files.includes(required)) {
      throw new Error(`Packed output is missing ${required}.`);
    }
  }
  for (const path of files) {
    if (
      !['package/LICENSE', 'package/README.md', 'package/package.json'].includes(path) &&
      !/^package\/dist\/.+\.(?:d\.ts|js)$/u.test(path)
    ) {
      throw new Error(`Packed output contains a forbidden file: ${path}.`);
    }
  }
  if (files.some((path) => path.endsWith('.map'))) {
    throw new Error('Packed source maps must not ship.');
  }

  run('corepack', ['pnpm', 'exec', 'publint', 'run', tarball, '--strict', '--pack=false']);
  run('corepack', [
    'pnpm',
    'exec',
    'attw',
    tarball,
    '--profile',
    'esm-only',
    '--entrypoints',
    '.',
    '--no-definitely-typed',
    '--no-summary',
    '--no-emoji',
    '--no-color',
  ]);

  const consumerRoot = join(temporaryRoot, 'consumer');
  mkdirSync(consumerRoot);
  writeFileSync(join(consumerRoot, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(
    join(consumerRoot, 'tsconfig.json'),
    `${JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        lib: ['ES2024'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        types: ['node'],
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['quick-start.ts', 'packed-consumer.ts'],
    })}\n`,
  );
  writeFileSync(
    join(consumerRoot, 'quick-start.ts'),
    readFileSync(join(repositoryRoot, 'examples', 'quick-start.ts')),
  );
  writeFileSync(
    join(consumerRoot, 'packed-consumer.ts'),
    readFileSync(join(repositoryRoot, 'scripts', 'packed-consumer.ts')),
  );
  writeFileSync(
    join(consumerRoot, 'packed-surface-probe.mjs'),
    readFileSync(join(repositoryRoot, 'scripts', 'packed-surface-probe.mjs')),
  );
  writeFileSync(
    join(consumerRoot, 'public-root-exports.json'),
    readFileSync(join(repositoryRoot, 'scripts', 'public-root-exports.json')),
  );
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball, `@types/node@${nodeTypes}`],
    consumerRoot,
  );

  const installed = join(consumerRoot, 'node_modules', '@revisium', 'revo-run');
  if (
    lstatSync(installed).isSymbolicLink() ||
    realpathSync(installed).startsWith(`${resolve(repositoryRoot)}${sep}`)
  ) {
    throw new Error('Smoke linked the repository checkout instead of installing the tarball.');
  }

  run(
    process.execPath,
    [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', consumerRoot],
    consumerRoot,
  );
  run(process.execPath, ['packed-surface-probe.mjs'], consumerRoot);
  run(process.execPath, ['quick-start.ts'], consumerRoot);
  run(process.execPath, ['packed-consumer.ts'], consumerRoot);
  process.stdout.write(`Verified ${basename(tarball)} with the tracked packed consumer.\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
