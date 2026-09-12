import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareRunManagerDatabase } from '../../src/index.js';
import {
  cleanupPreparationFixtures,
  freshDatabase,
} from '../support/database-preparation-fixture.js';
import { prepareInWorker, runPreparationWorker } from '../support/database-preparation-process.js';

afterEach(cleanupPreparationFixtures);

describe('DBOS database preparation', () => {
  it('migrates a fresh database and preserves data on repeat', async () => {
    const database = await freshDatabase();

    const first = await database.prepare();
    await database.remember('preserved');
    const repeated = await database.prepare();

    expect(first).toMatchObject({ schema: 'dbos', fromVersion: 0, migrated: true });
    expect(first.toVersion).toBeGreaterThan(0);
    expect(repeated).toEqual({
      schema: 'dbos',
      fromVersion: first.toVersion,
      toVersion: first.toVersion,
      migrated: false,
    });
    await expect(database.recall()).resolves.toBe('preserved');

    const manager = database.createManager();
    await manager.start();
    await manager.stop();
  });

  it('serializes concurrent preparation across processes', async () => {
    const database = await freshDatabase();

    const results = await Promise.all([
      prepareInWorker(database.url),
      prepareInWorker(database.url),
      prepareInWorker(database.url),
    ]);

    expect(results.filter((result) => result.migrated)).toHaveLength(1);
    expect(new Set(results.map((result) => result.toVersion)).size).toBe(1);
  });

  it('rejects an invalid stored migration version', async () => {
    const database = await freshDatabase();
    await database.prepare();
    await database.corruptMigrationVersion();

    await expect(database.prepare()).rejects.toMatchObject({
      code: 'run_manager_database_preparation_failed',
      stage: 'migration-version-read',
    });
  });

  it('can be cancelled while waiting for another preparation', async () => {
    const database = await freshDatabase();
    const lock = await database.holdMigrationLock();
    const controller = new AbortController();
    const preparation = database.prepare(controller.signal);

    await database.waitUntilPreparationIsBlocked();
    controller.abort();

    await expect(preparation).rejects.toMatchObject({
      code: 'run_manager_database_preparation_aborted',
    });
    await lock.release();
  });

  it('reports a lost preparation connection without exposing its URL', async () => {
    const database = await freshDatabase();
    const lock = await database.holdMigrationLock();
    const preparation = prepareRunManagerDatabase({ databaseUrl: database.url });

    await database.waitUntilPreparationIsBlocked();
    await database.terminatePreparationConnection();

    await expect(preparation).rejects.toMatchObject({
      code: 'run_manager_database_preparation_failed',
      stage: 'database-session-lost',
    });
    await lock.release();
  });

  it('redacts DBOS failures and removes temporary configuration', async () => {
    const database = await freshDatabase();
    const password = 'migration-failure-secret-sentinel';
    const limitedUrl = await database.limitedUserUrl(password);
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'revo-run-preparation-test-'));

    try {
      const failure = await runPreparationWorker(limitedUrl, { TMPDIR: temporaryRoot });

      expect(failure).toMatchObject({
        outcome: 'rejected',
        error: { stage: 'dbos-schema-migration', exitCode: 1 },
      });
      expect(JSON.stringify(failure)).not.toContain(password);
      expect(
        (await readdir(temporaryRoot)).filter((entry) => entry.startsWith('revo-run-dbos-')),
      ).toStrictEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
