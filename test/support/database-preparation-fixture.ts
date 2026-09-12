import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { unavailableAgentPort } from '../../src/composition/agent-port.js';
import { createRunManager, prepareRunManagerDatabase } from '../../src/index.js';
import { testDatabaseUrl } from './test-environment.js';

const advisoryLockKeys = [0x72_65_76_6f, 0x72_75_6e_01] as const;
const fixtures: DatabasePreparationFixture[] = [];

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const eventually = async (
  description: string,
  condition: () => Promise<boolean>,
  deadline = Date.now() + 10_000,
): Promise<void> => {
  // oxlint-disable-next-line no-await-in-loop -- Test polling is intentionally sequential.
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    // oxlint-disable-next-line no-await-in-loop -- Test polling is intentionally sequential.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
};

const adminQuery = async (text: string): Promise<void> => {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
};

export class DatabasePreparationFixture {
  private readonly clients = new Set<Client>();
  private readonly roles: string[] = [];

  constructor(
    readonly name: string,
    readonly url: string,
  ) {}

  async prepare(signal?: AbortSignal) {
    return await prepareRunManagerDatabase(
      signal === undefined ? { databaseUrl: this.url } : { databaseUrl: this.url, signal },
    );
  }

  createManager() {
    return createRunManager({
      agents: unavailableAgentPort,
      database: { url: this.url },
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
  }

  async connect(): Promise<Client> {
    const client = new Client({ connectionString: this.url });
    await client.connect();
    this.clients.add(client);
    return client;
  }

  async remember(value: string): Promise<void> {
    const client = await this.connect();
    await client.query('CREATE TABLE IF NOT EXISTS public.preparation_sentinel (value text)');
    await client.query('TRUNCATE public.preparation_sentinel');
    await client.query('INSERT INTO public.preparation_sentinel (value) VALUES ($1)', [value]);
  }

  async recall(): Promise<string | undefined> {
    const client = await this.connect();
    const result = await client.query<{ value: string }>(
      'SELECT value FROM public.preparation_sentinel LIMIT 1',
    );
    return result.rows[0]?.value;
  }

  async corruptMigrationVersion(): Promise<void> {
    const client = await this.connect();
    await client.query('UPDATE dbos.dbos_migrations SET version = -1');
  }

  async limitedUserUrl(password: string): Promise<string> {
    const role = `revo_prepare_${randomUUID().replaceAll('-', '')}`;
    await adminQuery(`CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD '${password}'`);
    this.roles.push(role);
    const url = new URL(this.url);
    url.username = role;
    url.password = password;
    return url.toString();
  }

  async holdMigrationLock(): Promise<{ release: () => Promise<void> }> {
    const client = await this.connect();
    await client.query('SELECT pg_advisory_lock($1, $2)', [...advisoryLockKeys]);
    return {
      release: async () => {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [...advisoryLockKeys]);
      },
    };
  }

  async waitUntilPreparationIsBlocked(): Promise<void> {
    const observer = await this.connect();
    await eventually('database preparation to wait for its advisory lock', async () => {
      const result = await observer.query<{ waiting: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'revo-run-database-preparation' AND query LIKE 'SELECT pg_try_advisory_lock%') AS waiting",
      );
      return result.rows[0]?.waiting === true;
    });
  }

  async terminatePreparationConnection(): Promise<void> {
    const observer = await this.connect();
    await eventually('database preparation connection', async () => {
      const result = await observer.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'revo-run-database-preparation' ORDER BY backend_start DESC LIMIT 1",
      );
      const pid = result.rows[0]?.pid;
      if (pid === undefined) {
        return false;
      }
      await observer.query('SELECT pg_terminate_backend($1)', [pid]);
      return true;
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients].map(async (client) => await client.end()));
    this.clients.clear();
    await adminQuery(`DROP DATABASE IF EXISTS ${quoteIdentifier(this.name)} WITH (FORCE)`);
    await Promise.all(
      this.roles.map(
        async (role) => await adminQuery(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`),
      ),
    );
  }
}

export const freshDatabase = async (): Promise<DatabasePreparationFixture> => {
  const name = `revo_run_prepare_${randomUUID().replaceAll('-', '')}`;
  await adminQuery(`CREATE DATABASE ${quoteIdentifier(name)}`);
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const fixture = new DatabasePreparationFixture(name, url.toString());
  fixtures.push(fixture);
  return fixture;
};

export const cleanupPreparationFixtures = async (): Promise<void> => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.close()));
};
