import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareRunManagerDatabase } from '../../src/index.js';
import { startPreparationWorker } from '../support/database-preparation-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const databaseNames: string[] = [];
const advisoryLockKeys = [0x7265_766f, 0x7275_6e01] as const;
const persistentChildHook = fileURLToPath(
  new URL('../support/process/ignore-sigterm-and-stay-alive.mjs', import.meta.url),
);
const quotedIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const createTestDatabase = async (): Promise<string> => {
  const rootUrl = testDatabaseUrl();
  const databaseName = `revo_run_cancel_${randomUUID().replaceAll('-', '')}`;
  const client = new Client({ connectionString: rootUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
  databaseNames.push(databaseName);
  const databaseUrl = new URL(rootUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return databaseUrl.toString();
};

const dropTestDatabase = async (databaseName: string): Promise<void> => {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await client.end();
  }
};

const waitForBlockedVersionRead = async (
  client: Client,
  deadline = Date.now() + 10_000,
): Promise<void> => {
  const result = await client.query<{ blocked: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'revo-run-database-preparation' AND wait_event_type = 'Lock') AS blocked",
  );
  if (result.rows[0]?.blocked === true) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error('Timed out waiting for a blocked migration-version read.');
  }
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  await waitForBlockedVersionRead(client, deadline);
};

const waitForMigration = async (client: Client, deadline = Date.now() + 10_000): Promise<void> => {
  const relation = await client.query<{ relation: string | null }>(
    "SELECT to_regclass('dbos.dbos_migrations')::text AS relation",
  );
  if (relation.rows[0]?.relation !== null) {
    const result = await client.query<{ version: number }>(
      'SELECT COALESCE(max(version), 0)::integer AS version FROM dbos.dbos_migrations',
    );
    if ((result.rows[0]?.version ?? 0) > 0) {
      return;
    }
  }
  if (Date.now() >= deadline) {
    throw new Error('Timed out waiting for DBOS migration persistence.');
  }
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  await waitForMigration(client, deadline);
};

const waitForPreparationConnectionsToClose = async (
  client: Client,
  deadline = Date.now() + 10_000,
): Promise<void> => {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'revo-run-database-preparation'",
  );
  if (result.rows[0]?.count === '0') {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error('Timed out waiting for the database preparation connection to close.');
  }
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  await waitForPreparationConnectionsToClose(client, deadline);
};

const waitForFile = async (path: string, deadline = Date.now() + 10_000): Promise<string> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the child-process signal marker.');
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    return await waitForFile(path, deadline);
  }
};

const waitForPreparationQuery = async (
  client: Client,
  queryPrefix: string,
  deadline = Date.now() + 10_000,
): Promise<void> => {
  const result = await client.query<{ active: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'revo-run-database-preparation' AND query LIKE $1) AS active",
    [`${queryPrefix}%`],
  );
  if (result.rows[0]?.active === true) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error(`Timed out waiting for preparation query ${queryPrefix}.`);
  }
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  await waitForPreparationQuery(client, queryPrefix, deadline);
};

const settleWithin = async <Value>(promise: Promise<Value>, timeoutMs = 1_500): Promise<Value> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<Value>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Database preparation abort timed out.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map(dropTestDatabase));
});

describe('DBOS database preparation cancellation', () => {
  it('aborts a migration-version read blocked by an ACCESS EXCLUSIVE lock', async () => {
    const databaseUrl = await createTestDatabase();
    await prepareRunManagerDatabase({ databaseUrl });
    const blocker = new Client({ connectionString: databaseUrl });
    const observer = new Client({ connectionString: databaseUrl });
    await Promise.all([blocker.connect(), observer.connect()]);
    try {
      await blocker.query('BEGIN');
      try {
        await blocker.query('LOCK TABLE dbos.dbos_migrations IN ACCESS EXCLUSIVE MODE');
        const controller = new AbortController();
        const preparation = prepareRunManagerDatabase({ databaseUrl, signal: controller.signal });
        await waitForBlockedVersionRead(observer);

        controller.abort();
        await expect(preparation).rejects.toMatchObject({
          code: 'run_manager_database_preparation_aborted',
        });
      } finally {
        await blocker.query('ROLLBACK');
      }
      await waitForPreparationConnectionsToClose(observer);
    } finally {
      await Promise.all([blocker.end(), observer.end()]);
    }
  });

  it('reaps an aborted migration child before force-closing a session with stalled unlock', async () => {
    const databaseUrl = await createTestDatabase();
    const isolatedTempRoot = await mkdtemp(join(tmpdir(), 'revo-run-child-abort-test-'));
    const marker = join(isolatedTempRoot, 'sigterm-received');
    const observer = new Client({ connectionString: databaseUrl });
    const competitor = new Client({ connectionString: databaseUrl });
    await Promise.all([observer.connect(), competitor.connect()]);
    try {
      await observer.query(`
        CREATE OR REPLACE FUNCTION public.pg_advisory_unlock(integer, integer)
        RETURNS boolean
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM pg_sleep(30);
          RETURN pg_catalog.pg_advisory_unlock($1, $2);
        END
        $$
      `);
      const stalledUrl = new URL(databaseUrl);
      stalledUrl.searchParams.set('options', '-c search_path=public,pg_catalog');
      const worker = startPreparationWorker(stalledUrl.toString(), {
        TMPDIR: isolatedTempRoot,
        REVO_RUN_PREPARATION_CHILD_NODE_OPTIONS: `--import=${persistentChildHook}`,
        REVO_RUN_PREPARATION_SIGTERM_MARKER: marker,
      });
      await waitForMigration(observer);
      const abortStarted = Date.now();
      await worker.abort();
      expect(await waitForFile(marker)).toContain('received');
      await expect(
        competitor.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS acquired', [
          ...advisoryLockKeys,
        ]),
      ).resolves.toMatchObject({ rows: [{ acquired: false }] });
      const failure = await settleWithin(worker.completion, 2_500);

      expect(failure).toMatchObject({
        outcome: 'rejected',
        error: { code: 'run_manager_database_preparation_aborted' },
      });
      expect(Date.now() - abortStarted).toBeGreaterThanOrEqual(900);
      expect(
        (await readdir(isolatedTempRoot)).filter((entry) => entry.startsWith('revo-run-dbos-')),
      ).toStrictEqual([]);
      await waitForPreparationConnectionsToClose(observer);
      await expect(
        competitor.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS acquired', [
          ...advisoryLockKeys,
        ]),
      ).resolves.toMatchObject({ rows: [{ acquired: true }] });
      await competitor.query('SELECT pg_advisory_unlock($1, $2)', [...advisoryLockKeys]);
    } finally {
      await Promise.all([observer.end(), competitor.end()]);
      await rm(isolatedTempRoot, { recursive: true, force: true });
    }
  });

  it('force-closes its owned client when abort stalls during advisory unlock', async () => {
    const databaseUrl = await createTestDatabase();
    await prepareRunManagerDatabase({ databaseUrl });
    const observer = new Client({ connectionString: databaseUrl });
    await observer.connect();
    try {
      await observer.query(`
        CREATE OR REPLACE FUNCTION public.pg_advisory_unlock(integer, integer)
        RETURNS boolean
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM pg_sleep(30);
          RETURN pg_catalog.pg_advisory_unlock($1, $2);
        END
        $$
      `);
      const stalledUrl = new URL(databaseUrl);
      stalledUrl.searchParams.set('options', '-c search_path=public,pg_catalog');
      const controller = new AbortController();
      const preparation = prepareRunManagerDatabase({
        databaseUrl: stalledUrl.toString(),
        signal: controller.signal,
      });
      await waitForPreparationQuery(observer, 'SELECT pg_advisory_unlock');

      controller.abort();
      await expect(settleWithin(preparation)).rejects.toMatchObject({
        code: 'run_manager_database_preparation_cleanup_failed',
        primary: { code: 'run_manager_database_preparation_aborted' },
        errors: [
          { code: 'run_manager_database_preparation_aborted' },
          { stage: 'advisory-lock-release' },
        ],
      });
    } finally {
      await observer.end();
    }
  });
});
