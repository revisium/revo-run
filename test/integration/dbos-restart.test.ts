import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseRunSnapshot } from '../support/parse-run-snapshot.js';
import { assertIsolatedTestDatabase } from '../support/test-database.js';

const databaseUrl = process.env['DATABASE_URL'];
const integration = databaseUrl === undefined ? describe.skip : describe;
const waitForFile = async (file: string, deadline = Date.now() + 20_000): Promise<string> => {
  try {
    return await readFile(file, 'utf8');
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for integration file ${file}.`, { cause: error });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return waitForFile(file, deadline);
  }
};
const waitForExit = (child: ChildProcess, deadline = Date.now() + 20_000): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        reject(new Error(`Timed out waiting for restart worker ${String(child.pid)} to exit.`));
      },
      Math.max(0, deadline - Date.now()),
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 || signal === 'SIGKILL') resolve();
      else reject(new Error(`restart worker exited with ${String(code)} (${String(signal)})`));
    });
  });
};
const terminate = async (child: ChildProcess | undefined): Promise<void> => {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForExit(child);
};

integration('package DBOS restart and replay', () => {
  it('recovers an interrupted manager workflow and adopts its completed child exactly once', async () => {
    if (databaseUrl === undefined) throw new Error('DATABASE_URL is required.');
    assertIsolatedTestDatabase(databaseUrl);
    const directory = await mkdtemp(join(tmpdir(), 'revo-run-restart-'));
    const worker = join(import.meta.dirname, '../support/dbos-restart-worker.ts');
    const launch = (mode: 'first' | 'recover') =>
      spawn(process.execPath, ['--import', 'tsx', worker, mode, directory, databaseUrl], {
        stdio: 'inherit',
      });

    let first: ChildProcess | undefined;
    let recovered: ChildProcess | undefined;
    try {
      first = launch('first');
      await waitForFile(join(directory, 'accepted.json'));
      await waitForFile(join(directory, 'executions.txt'));
      await waitForFile(join(directory, 'terminal-reached'));
      first.kill('SIGKILL');
      await waitForExit(first);

      recovered = launch('recover');
      await waitForExit(recovered);
      const accepted = parseRunSnapshot(await readFile(join(directory, 'accepted.json'), 'utf8'));
      const final = parseRunSnapshot(await readFile(join(directory, 'snapshot.json'), 'utf8'));
      expect(accepted).toMatchObject({ id: final.id, status: 'pending' });
      expect(final).toMatchObject({ status: 'succeeded', result: { outcome: 'succeeded' } });
      expect(await readFile(join(directory, 'executions.txt'), 'utf8')).toBe('1');
    } finally {
      await terminate(first);
      await terminate(recovered);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
