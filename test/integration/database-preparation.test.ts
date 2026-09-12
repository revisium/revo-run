import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { unavailableAgentPort } from '../../src/composition/agent-port.js';
import { createRunManager, prepareRunManagerDatabase } from '../../src/index.js';
import { prepareInProcess, runPreparationWorker } from '../support/database-preparation-process.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const databaseNames: string[] = [];
const roleNames: string[] = [];
const advisoryLockKeys = [0x7265_766f, 0x7275_6e01] as const;

const quotedIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const createTestDatabase = async (): Promise<string> => {
  const rootUrl = testDatabaseUrl();
  const databaseName = `revo_run_prepare_${randomUUID().replaceAll('-', '')}`;
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

const dropTestRole = async (roleName: string): Promise<void> => {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`DROP ROLE IF EXISTS ${quotedIdentifier(roleName)}`);
  } finally {
    await client.end();
  }
};

const createLimitedDatabaseUser = async (databaseUrl: string): Promise<string> => {
  const roleName = `revo_prepare_limited_${randomUUID().replaceAll('-', '')}`;
  const password = 'migration-failure-secret-sentinel';
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`CREATE ROLE ${quotedIdentifier(roleName)} LOGIN PASSWORD '${password}'`);
  } finally {
    await client.end();
  }
  roleNames.push(roleName);
  const limitedUrl = new URL(databaseUrl);
  limitedUrl.username = roleName;
  limitedUrl.password = password;
  return limitedUrl.toString();
};

const managerOptions = (databaseUrl: string) => ({
  agents: unavailableAgentPort,
  database: { url: databaseUrl },
  host: {
    resources: { inspect: async () => undefined },
    workspaces: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('Database preparation test does not acquire a workspace.');
      },
    },
    credentials: {
      inspect: async () => undefined,
      acquire: async () => {
        throw new Error('Database preparation test does not acquire credentials.');
      },
    },
  },
});

const findPreparationBackend = async (
  client: Client,
  deadline = Date.now() + 10_000,
): Promise<number> => {
  const result = await client.query<{ pid: number }>(
    "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'revo-run-database-preparation' AND query LIKE 'SELECT pg_try_advisory_lock%' ORDER BY backend_start DESC LIMIT 1",
  );
  const pid = result.rows[0]?.pid;
  if (pid !== undefined) {
    return pid;
  }
  if (Date.now() >= deadline) {
    throw new Error('Timed out waiting for the database preparation backend.');
  }
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  return await findPreparationBackend(client, deadline);
};

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map(dropTestDatabase));
  await Promise.all(roleNames.splice(0).map(dropTestRole));
});

describe('DBOS database preparation', () => {
  it('migrates a fresh database, preserves data on repeat, and permits normal manager lifecycle', async () => {
    const databaseUrl = await createTestDatabase();

    const fresh = await prepareRunManagerDatabase({ databaseUrl });
    expect(fresh.schema).toBe('dbos');
    expect(fresh.fromVersion).toBe(0);
    expect(fresh.migrated).toBe(true);
    expect(fresh.toVersion).toBeGreaterThan(0);

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('CREATE TABLE public.preparation_sentinel (value text PRIMARY KEY)');
      await client.query('INSERT INTO public.preparation_sentinel (value) VALUES ($1)', [
        'preserved',
      ]);
    } finally {
      await client.end();
    }

    const repeated = await prepareRunManagerDatabase({ databaseUrl });
    expect(repeated).toEqual({
      schema: 'dbos',
      fromVersion: fresh.toVersion,
      toVersion: fresh.toVersion,
      migrated: false,
    });

    const verification = new Client({ connectionString: databaseUrl });
    await verification.connect();
    try {
      await expect(
        verification.query<{ value: string }>('SELECT value FROM public.preparation_sentinel'),
      ).resolves.toMatchObject({ rows: [{ value: 'preserved' }] });
    } finally {
      await verification.end();
    }

    const manager = createRunManager(managerOptions(databaseUrl));
    await manager.start();
    await manager.stop();
  });

  it('serializes concurrent first preparation across callers', async () => {
    const databaseUrl = await createTestDatabase();

    const preparations = await Promise.all([
      prepareRunManagerDatabase({ databaseUrl }),
      prepareRunManagerDatabase({ databaseUrl }),
      prepareRunManagerDatabase({ databaseUrl }),
    ]);

    const migrated = preparations.filter((result) => result.migrated);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ fromVersion: 0 });
    const toVersions = new Set(preparations.map((result) => result.toVersion));
    expect(toVersions.size).toBe(1);
    expect(preparations.every((result) => result.toVersion > 0)).toBe(true);
  });

  it('fails closed when the persisted DBOS migration version is invalid', async () => {
    const databaseUrl = await createTestDatabase();
    await prepareRunManagerDatabase({ databaseUrl });
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('UPDATE dbos.dbos_migrations SET version = -1');
    } finally {
      await client.end();
    }

    await expect(prepareRunManagerDatabase({ databaseUrl })).rejects.toMatchObject({
      code: 'run_manager_database_preparation_failed',
      stage: 'migration-version-read',
    });
  });

  it('serializes concurrent first preparation across processes and lets workers exit', async () => {
    const databaseUrl = await createTestDatabase();

    const preparations = await Promise.all([
      prepareInProcess(databaseUrl),
      prepareInProcess(databaseUrl),
      prepareInProcess(databaseUrl),
    ]);

    expect(preparations.filter((result) => result.migrated)).toHaveLength(1);
    expect(preparations.filter((result) => result.fromVersion === 0)).toHaveLength(1);
    expect(new Set(preparations.map((result) => result.toVersion)).size).toBe(1);
  });

  it('redacts a schema failure and removes its private configuration', async () => {
    const databaseUrl = await createTestDatabase();
    const limitedUrl = await createLimitedDatabaseUser(databaseUrl);
    const isolatedTempRoot = await mkdtemp(join(tmpdir(), 'revo-run-preparation-test-'));
    try {
      const failure = await runPreparationWorker(limitedUrl, { TMPDIR: isolatedTempRoot });
      expect(failure).toMatchObject({
        outcome: 'rejected',
        error: {
          code: 'run_manager_database_preparation_failed',
          stage: 'dbos-schema-migration',
          exitCode: 1,
        },
      });
      expect(JSON.stringify(failure)).not.toContain('migration-failure-secret-sentinel');
      const leftovers = (await readdir(isolatedTempRoot)).filter((entry) =>
        entry.startsWith('revo-run-dbos-'),
      );
      expect(leftovers).toStrictEqual([]);
    } finally {
      await rm(isolatedTempRoot, { recursive: true, force: true });
    }
  });

  it('aborts advisory-lock polling without acquiring the lock', async () => {
    const databaseUrl = await createTestDatabase();
    const blocker = new Client({ connectionString: databaseUrl });
    const observer = new Client({ connectionString: databaseUrl });
    await Promise.all([blocker.connect(), observer.connect()]);
    try {
      await blocker.query('SELECT pg_advisory_lock($1, $2)', [...advisoryLockKeys]);
      const controller = new AbortController();
      const preparation = prepareRunManagerDatabase({ databaseUrl, signal: controller.signal });
      await findPreparationBackend(observer);

      controller.abort();
      await expect(preparation).rejects.toMatchObject({
        code: 'run_manager_database_preparation_aborted',
      });
      await blocker.query('SELECT pg_advisory_unlock($1, $2)', [...advisoryLockKeys]);
    } finally {
      await Promise.all([blocker.end(), observer.end()]);
    }
  });

  it('survives forced PostgreSQL session loss in a forked preparation worker', async () => {
    const databaseUrl = await createTestDatabase();
    const blocker = new Client({ connectionString: databaseUrl });
    const observer = new Client({ connectionString: databaseUrl });
    await Promise.all([blocker.connect(), observer.connect()]);
    try {
      await blocker.query('SELECT pg_advisory_lock($1, $2)', [...advisoryLockKeys]);
      const preparation = runPreparationWorker(databaseUrl);
      const pid = await findPreparationBackend(observer);

      await observer.query('SELECT pg_terminate_backend($1)', [pid]);
      const failure = await preparation;

      expect(failure).toMatchObject({
        outcome: 'rejected',
        error: {
          code: 'run_manager_database_preparation_failed',
          stage: 'database-session-lost',
        },
      });
      expect(JSON.stringify(failure)).not.toContain(databaseUrl);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1, $2)', [...advisoryLockKeys]);
      await Promise.all([blocker.end(), observer.end()]);
    }
  });

  it('normalizes forced PostgreSQL session loss in the current process', async () => {
    const databaseUrl = await createTestDatabase();
    const blocker = new Client({ connectionString: databaseUrl });
    const observer = new Client({ connectionString: databaseUrl });
    await Promise.all([blocker.connect(), observer.connect()]);
    try {
      await blocker.query('SELECT pg_advisory_lock($1, $2)', [...advisoryLockKeys]);
      const preparation = prepareRunManagerDatabase({ databaseUrl });
      const pid = await findPreparationBackend(observer);

      await observer.query('SELECT pg_terminate_backend($1)', [pid]);
      await expect(preparation).rejects.toMatchObject({
        code: 'run_manager_database_preparation_failed',
        stage: 'database-session-lost',
      });
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1, $2)', [...advisoryLockKeys]);
      await Promise.all([blocker.end(), observer.end()]);
    }
  });
});
