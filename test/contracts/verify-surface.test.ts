import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const scanner = fileURLToPath(new URL('../../scripts/verify-surface.ts', import.meta.url));
const temporaryRoots: string[] = [];
const requiredDirectories = ['src', 'test', 'docs', 'scripts', 'examples'] as const;
const requiredFiles = ['README.md', 'REPOSITORY.md', 'REVIEW.md', 'VERIFICATION.md'] as const;
const requiredRoots = [...requiredDirectories, ...requiredFiles] as const;

const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'revo-run-surface-'));
  temporaryRoots.push(root);
  for (const directory of requiredDirectories) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const file of requiredFiles) {
    writeFileSync(join(root, file), '');
  }
  return root;
};

const scan = (root: string) =>
  spawnSync(process.execPath, ['--experimental-strip-types', scanner, root], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/revo-run-test-path-without-rg' },
  });

const writeFixture = (root: string, path: string, source: string): void => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
};

describe('portable required surface scans', () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes a clean tree without relying on an ambient ripgrep binary', () => {
    const result = scan(temporaryRoot());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it.each(requiredRoots)('fails closed when required scan root %s is missing', (path) => {
    const root = temporaryRoot();
    rmSync(join(root, path), { recursive: true, force: true });

    const result = scan(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Required surface scan cannot inspect ${path}: ENOENT.`);
  });

  it.each(requiredRoots)('fails closed when required scan root %s is renamed', (path) => {
    const root = temporaryRoot();
    renameSync(join(root, path), join(root, `${path}.renamed`));

    const result = scan(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Required surface scan cannot inspect ${path}: ENOENT.`);
  });

  it.each([
    {
      path: 'src/legacy.ts',
      source: ['Execution', 'Plan'].join(''),
      failure: 'Legacy plan/executor symbols remain in the active RN1 surface.',
    },
    {
      path: 'src/hook.js',
      source: ['Symbol', '.for("fault")'].join(''),
      failure: 'Production source still contains a test hook or marker.',
    },
    {
      path: 'src/probe.ts',
      source: ['Workflow', 'Probe'].join(''),
      failure: 'Production source still contains a workflow probe.',
    },
    {
      path: 'src/import.ts',
      source: ['import value from "../', 'test/support/value.js";'].join(''),
      failure: 'Production source imports test-only code.',
    },
  ])('fails closed on $path when ripgrep is unavailable', ({ failure, path, source }) => {
    const root = temporaryRoot();
    writeFixture(root, path, source);

    const result = scan(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path}:1:${source}`);
    expect(result.stderr).toContain(failure);
  });

  it.each([
    {
      name: 'file symlink to an out-of-scope file',
      prepare: (root: string) => {
        writeFixture(root, 'payload.ts', ['Workflow', 'Probe'].join(''));
        mkdirSync(join(root, 'src'), { recursive: true });
        symlinkSync('../payload.ts', join(root, 'src/link.ts'), 'file');
      },
      path: 'src/link.ts',
    },
    {
      name: 'directory symlink to an out-of-scope tree',
      prepare: (root: string) => {
        writeFixture(root, 'payload/probe.ts', ['Workflow', 'Probe'].join(''));
        mkdirSync(join(root, 'src'), { recursive: true });
        symlinkSync('../payload', join(root, 'src/link'), 'dir');
      },
      path: 'src/link',
    },
    {
      name: 'broken symlink',
      prepare: (root: string) => {
        mkdirSync(join(root, 'src'), { recursive: true });
        symlinkSync('../missing.ts', join(root, 'src/link.ts'), 'file');
      },
      path: 'src/link.ts',
    },
    {
      name: 'directory cycle',
      prepare: (root: string) => {
        mkdirSync(join(root, 'src'), { recursive: true });
        symlinkSync('.', join(root, 'src/cycle'), 'dir');
      },
      path: 'src/cycle',
    },
  ])('rejects a $name without following it', ({ path, prepare }) => {
    const root = temporaryRoot();
    prepare(root);

    const result = scan(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Unsupported symbolic link in required surface scan scope: ${path}.`,
    );
  });

  it('fails closed when a required file cannot be read', () => {
    const root = temporaryRoot();
    writeFixture(root, 'src/unreadable.ts', 'export {};');
    const unreadable = join(root, 'src/unreadable.ts');
    chmodSync(unreadable, 0);

    const result = scan(root);
    chmodSync(unreadable, 0o600);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Required surface scan cannot read file src/unreadable.ts: EACCES.',
    );
  });

  it('rejects an unsupported filesystem entry instead of skipping it', async () => {
    const root = temporaryRoot();
    const socket = join(root, 'src/runtime.sock');
    mkdirSync(dirname(socket), { recursive: true });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    try {
      const result = scan(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Unsupported filesystem entry in required surface scan scope: src/runtime.sock.',
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
