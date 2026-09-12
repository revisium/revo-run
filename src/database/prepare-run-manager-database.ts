import { Client, type QueryResult, type QueryResultRow } from 'pg';

import type {
  PrepareRunManagerDatabaseOptions,
  PrepareRunManagerDatabaseResult,
  RunManagerDatabasePreparationFailure,
  RunManagerDatabasePreparationStage,
} from '../contracts/database-preparation.js';
import { runDbosSchemaMigration } from './dbos-schema-command.js';
import { forceClosePgClientSocket } from './pg-client-termination.js';
import {
  normalizePreparationFailures,
  preparationAborted,
  preparationFailure,
} from './preparation-failures.js';

const advisoryLockKeys = [0x72_65_76_6f, 0x72_75_6e_01] as const;

type PreparationOptions = Readonly<{ databaseUrl: string; signal?: AbortSignal }>;

const invalidOptions = (): never => {
  throw preparationFailure('input-validation');
};

const parseOptions = (input: unknown): PreparationOptions => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalidOptions();
  }

  const databaseUrl = 'databaseUrl' in input ? input.databaseUrl : undefined;
  const signal = 'signal' in input ? input.signal : undefined;
  if (
    typeof databaseUrl !== 'string' ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  ) {
    return invalidOptions();
  }

  try {
    const url = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname === '' ||
      url.pathname.length <= 1
    ) {
      return invalidOptions();
    }
  } catch {
    return invalidOptions();
  }

  return signal === undefined ? { databaseUrl } : { databaseUrl, signal };
};

const waitForRetry = async (signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolveDelay();
    }, 50);
    const abort = (): void => {
      clearTimeout(timer);
      rejectDelay(preparationAborted());
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
};

class PreparationDatabase {
  private readonly cancellation = new AbortController();
  private failure: RunManagerDatabasePreparationFailure | undefined;
  private locked = false;
  private migrationRunning = false;
  private connectionDestroyed = false;

  constructor(
    readonly databaseUrl: string,
    private readonly client: Client,
    private readonly externalSignal?: AbortSignal,
  ) {
    client.on('error', this.onConnectionLost);
    externalSignal?.addEventListener('abort', this.onAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.cancellation.signal;
  }

  private readonly onAbort = (): void => {
    this.stop(preparationAborted());
  };

  private readonly onConnectionLost = (): void => {
    this.stop(preparationFailure('database-session-lost'));
  };

  private stop(failure: RunManagerDatabasePreparationFailure): void {
    this.failure ??= failure;
    this.cancellation.abort();
    if (!this.migrationRunning) {
      this.destroyConnection();
    }
  }

  private destroyConnection(): void {
    if (this.connectionDestroyed) {
      return;
    }
    this.connectionDestroyed = true;
    try {
      forceClosePgClientSocket(this.client);
    } catch {
      // The active PostgreSQL operation will still reject with its public stage.
    }
  }

  private async run<Value>(
    stage: RunManagerDatabasePreparationStage,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    try {
      return await operation();
    } catch (error) {
      throw this.failure ?? normalizePreparationFailures(error, stage);
    }
  }

  async connect(): Promise<void> {
    await this.run('database-connection', async () => await this.client.connect());
  }

  async acquireMigrationLock(): Promise<void> {
    while (!this.locked) {
      // oxlint-disable-next-line no-await-in-loop -- Advisory locks are acquired by polling serially.
      const result = await this.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        advisoryLockKeys,
        'advisory-lock-acquisition',
      );
      this.locked = result.rows[0]?.acquired === true;
      if (!this.locked) {
        // oxlint-disable-next-line no-await-in-loop -- Each retry waits before the next lock attempt.
        await this.run('advisory-lock-acquisition', async () => await waitForRetry(this.signal));
      }
    }
  }

  async readMigrationVersion(): Promise<number> {
    const table = await this.query<{ table_name: string | null }>(
      'SELECT to_regclass($1)::text AS table_name',
      ['dbos.dbos_migrations'],
      'migration-version-read',
    );
    if (table.rows[0]?.table_name === null) {
      return 0;
    }

    const version = await this.query<{ version: string | number }>(
      'SELECT version FROM dbos.dbos_migrations ORDER BY version DESC LIMIT 1',
      [],
      'migration-version-read',
    );
    const parsed = Number(version.rows[0]?.version ?? 0);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw preparationFailure('migration-version-read');
    }
    return parsed;
  }

  async migrate(): Promise<void> {
    this.migrationRunning = true;
    try {
      await runDbosSchemaMigration(this.databaseUrl, this.signal);
    } catch (error) {
      throw this.failure ?? normalizePreparationFailures(error, 'dbos-schema-migration');
    } finally {
      this.migrationRunning = false;
    }
  }

  private async query<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[],
    stage: RunManagerDatabasePreparationStage,
  ): Promise<QueryResult<Row>> {
    return await this.run(stage, async () => await this.client.query<Row>(text, [...values]));
  }

  async close(primaryFailure?: RunManagerDatabasePreparationFailure): Promise<void> {
    let cleanupFailure: RunManagerDatabasePreparationFailure | undefined;
    if (this.locked && !this.connectionDestroyed) {
      try {
        await this.client.query('SELECT pg_advisory_unlock($1, $2)', [...advisoryLockKeys]);
      } catch {
        cleanupFailure = preparationFailure('cleanup');
      }
    }
    try {
      await this.client.end();
    } catch {
      cleanupFailure ??= preparationFailure('cleanup');
    } finally {
      this.externalSignal?.removeEventListener('abort', this.onAbort);
      this.client.removeListener('error', this.onConnectionLost);
    }
    if (primaryFailure !== undefined) {
      throw primaryFailure;
    }
    if (cleanupFailure !== undefined) {
      throw cleanupFailure;
    }
  }
}

const openPreparationDatabase = (options: PreparationOptions): PreparationDatabase => {
  try {
    return new PreparationDatabase(
      options.databaseUrl,
      new Client({
        application_name: 'revo-run-database-preparation',
        connectionString: options.databaseUrl,
      }),
      options.signal,
    );
  } catch {
    throw preparationFailure('database-connection');
  }
};

export function prepareRunManagerDatabase(
  options: PrepareRunManagerDatabaseOptions,
): Promise<PrepareRunManagerDatabaseResult>;
export async function prepareRunManagerDatabase(
  input: unknown,
): Promise<PrepareRunManagerDatabaseResult> {
  const options = parseOptions(input);
  if (options.signal?.aborted === true) {
    throw preparationAborted();
  }

  const database = openPreparationDatabase(options);
  let result: PrepareRunManagerDatabaseResult | undefined;
  let failure: RunManagerDatabasePreparationFailure | undefined;

  try {
    await database.connect();
    await database.acquireMigrationLock();
    const fromVersion = await database.readMigrationVersion();
    await database.migrate();
    const toVersion = await database.readMigrationVersion();
    result = { schema: 'dbos', fromVersion, toVersion, migrated: fromVersion !== toVersion };
  } catch (error) {
    failure = normalizePreparationFailures(error, 'dbos-schema-migration');
  }

  await database.close(failure);
  if (result === undefined) {
    throw failure ?? preparationFailure('dbos-schema-migration');
  }
  return result;
}
