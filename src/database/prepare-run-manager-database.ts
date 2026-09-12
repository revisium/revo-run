import { Client, type QueryResult, type QueryResultRow } from 'pg';

import type {
  PrepareRunManagerDatabaseOptions,
  PrepareRunManagerDatabaseResult,
  RunManagerDatabasePreparationFailure,
  RunManagerDatabasePreparationStage,
} from '../contracts/database-preparation.js';
import { RunManagerDatabasePreparationAggregateError } from '../contracts/database-preparation.js';
import {
  type ValidatedDatabasePreparationOptions,
  validateDatabasePreparationOptions,
} from './database-preparation-options.js';
import { runDbosSchemaMigration } from './dbos-schema-command.js';
import { forceClosePgClientSocket } from './pg-client-termination.js';
import {
  normalizePreparationFailures,
  preparationAborted,
  preparationFailure,
  throwPreparationFailures,
} from './preparation-failures.js';

const dbosSchemaName = 'dbos';
const advisoryLockKeys = Object.freeze([0x72_65_76_6f, 0x72_75_6e_01] as const);
const advisoryLockRetryMs = 50;

/* eslint-disable no-await-in-loop -- Advisory-lock acquisition is intentionally serialized polling; remove when pg exposes abortable lock acquisition. */

type PgQuery = <Row extends QueryResultRow>(
  text: string,
  values?: readonly unknown[],
) => Promise<QueryResult<Row>>;
type PreparationPhase = 'postgresql' | 'dbos-child' | 'cleanup';

const readMigrationVersion = async (query: PgQuery): Promise<number> => {
  const table = await query<{ table_name: string | null }>(
    'SELECT to_regclass($1)::text AS table_name',
    [`${dbosSchemaName}.dbos_migrations`],
  );
  if (table.rows[0]?.table_name === null) {
    return 0;
  }
  const version = await query<{ version: string | number }>(
    `SELECT version FROM "${dbosSchemaName}"."dbos_migrations" ORDER BY version DESC LIMIT 1`,
  );
  const parsed = Number(version.rows[0]?.version ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw preparationFailure('migration-version-read');
  }
  return parsed;
};

const abortableDelay = async (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    throw preparationAborted();
  }
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolveDelay();
    }, advisoryLockRetryMs);
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

const createPreparationClient = (databaseUrl: string): Client => {
  try {
    return new Client({
      application_name: 'revo-run-database-preparation',
      connectionString: databaseUrl,
    });
  } catch {
    throw preparationFailure('database-connection');
  }
};

class DatabasePreparationSession {
  private readonly cancellation = new AbortController();
  private readonly cleanupFailures: RunManagerDatabasePreparationFailure[] = [];
  private primaryFailure: RunManagerDatabasePreparationFailure | undefined;
  private clientEnd: Promise<void> | undefined;
  private locked = false;
  private closing = false;
  private clientFailureRecorded = false;
  private phase: PreparationPhase = 'postgresql';
  private result: PrepareRunManagerDatabaseResult | undefined;

  constructor(
    private readonly options: ValidatedDatabasePreparationOptions,
    private readonly client: Client,
  ) {}

  async prepare(): Promise<PrepareRunManagerDatabaseResult> {
    this.client.on('error', this.onClientError);
    this.options.signal?.addEventListener('abort', this.onExternalAbort, { once: true });
    try {
      try {
        await this.runPreparation();
      } catch (error) {
        this.capturePrimaryFailure(error);
      } finally {
        await this.cleanup();
      }
    } finally {
      this.options.signal?.removeEventListener('abort', this.onExternalAbort);
      this.client.removeListener('error', this.onClientError);
    }
    throwPreparationFailures(this.primaryFailure, this.cleanupFailures);
    if (this.result === undefined) {
      throw preparationFailure('dbos-schema-migration');
    }
    return this.result;
  }

  private readonly onExternalAbort = (): void => {
    this.recordPrimary(preparationAborted());
    if (this.phase !== 'dbos-child') {
      void this.endClient(true);
    }
  };

  private readonly onClientError = (): void => {
    if (this.clientFailureRecorded) {
      return;
    }
    this.clientFailureRecorded = true;
    const failure = preparationFailure(
      this.closing ? 'database-connection-close' : 'database-session-lost',
    );
    if (this.closing) {
      this.cleanupFailures.push(failure);
      return;
    }
    this.recordPrimary(failure);
    void this.endClient(true);
  };

  private recordPrimary(failure: RunManagerDatabasePreparationFailure): void {
    this.primaryFailure ??= failure;
    if (!this.cancellation.signal.aborted) {
      this.cancellation.abort();
    }
  }

  private startClientEnd(): Promise<void> {
    if (this.clientEnd !== undefined) {
      return this.clientEnd;
    }
    let ending: unknown;
    const invokeClientEnd = (): unknown => this.client.end();
    try {
      ending = invokeClientEnd();
    } catch {
      this.cleanupFailures.push(preparationFailure('database-connection-close'));
      this.clientEnd = Promise.resolve();
      return this.clientEnd;
    }
    const closed = Promise.resolve(ending)
      .then(() => undefined)
      .catch(() => {
        this.cleanupFailures.push(preparationFailure('database-connection-close'));
      });
    this.clientEnd = closed;
    return closed;
  }

  private endClient(force = false): Promise<void> {
    const ending = this.startClientEnd();
    if (force) {
      try {
        forceClosePgClientSocket(this.client);
      } catch {
        this.cleanupFailures.push(preparationFailure('database-connection-close'));
      }
    }
    return ending;
  }

  private async runPgOperation<Value>(
    operation: () => Promise<Value>,
    failureStage: RunManagerDatabasePreparationStage,
  ): Promise<Value> {
    if (this.cancellation.signal.aborted) {
      await this.endClient(true);
      throw this.primaryFailure ?? preparationAborted();
    }
    let rejectCancellation: ((reason: RunManagerDatabasePreparationFailure) => void) | undefined;
    const cancellationResult = new Promise<Value>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onCancellation = (): void => {
      void this.endClient(true).then(() =>
        rejectCancellation?.(this.primaryFailure ?? preparationAborted()),
      );
    };
    this.cancellation.signal.addEventListener('abort', onCancellation, { once: true });
    if (this.cancellation.signal.aborted) {
      onCancellation();
    }
    try {
      return await Promise.race([Promise.resolve().then(operation), cancellationResult]);
    } catch (error) {
      if (this.cancellation.signal.aborted) {
        throw this.primaryFailure ?? preparationAborted();
      }
      const [failure] = normalizePreparationFailures(error, failureStage);
      throw failure ?? preparationFailure(failureStage);
    } finally {
      this.cancellation.signal.removeEventListener('abort', onCancellation);
    }
  }

  private readonly query: PgQuery = async <Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> =>
    await this.runPgOperation(
      async () => await this.client.query<Row>(text, values === undefined ? [] : [...values]),
      text.startsWith('SELECT pg_try_advisory_lock')
        ? 'advisory-lock-acquisition'
        : 'migration-version-read',
    );

  private async runPreparation(): Promise<void> {
    await this.runPgOperation(async () => await this.client.connect(), 'database-connection');
    await this.acquireAdvisoryLock();
    const fromVersion = await readMigrationVersion(this.query);
    this.phase = 'dbos-child';
    await runDbosSchemaMigration(this.options.databaseUrl, this.cancellation.signal);
    this.phase = 'postgresql';
    const toVersion = await readMigrationVersion(this.query);
    this.result = {
      schema: dbosSchemaName,
      fromVersion,
      toVersion,
      migrated: toVersion !== fromVersion,
    };
  }

  private async acquireAdvisoryLock(): Promise<void> {
    while (!this.locked) {
      const lock = await this.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        advisoryLockKeys,
      );
      this.locked = lock.rows[0]?.acquired === true;
      if (!this.locked) {
        await abortableDelay(this.cancellation.signal);
      }
    }
  }

  private capturePrimaryFailure(error: unknown): void {
    if (error instanceof RunManagerDatabasePreparationAggregateError) {
      if (error.primary !== undefined && this.primaryFailure === undefined) {
        this.recordPrimary(error.primary);
      }
      this.cleanupFailures.push(...error.cleanup);
      return;
    }
    const [failure] = normalizePreparationFailures(error, 'dbos-schema-migration');
    if (failure !== undefined && this.primaryFailure === undefined) {
      this.recordPrimary(failure);
    }
  }

  private async cleanup(): Promise<void> {
    this.closing = true;
    this.phase = 'cleanup';
    if (this.cancellation.signal.aborted) {
      await this.endClient(true);
      return;
    }
    if (this.locked && this.clientEnd === undefined) {
      try {
        await this.client.query('SELECT pg_advisory_unlock($1, $2)', [...advisoryLockKeys]);
      } catch (error) {
        this.cleanupFailures.push(...normalizePreparationFailures(error, 'advisory-lock-release'));
      }
    }
    await this.endClient();
  }
}

export const prepareRunManagerDatabase = async (
  rawOptions: PrepareRunManagerDatabaseOptions,
): Promise<PrepareRunManagerDatabaseResult> => {
  const options = validateDatabasePreparationOptions(rawOptions);
  if (options.signal?.aborted === true) {
    throw preparationAborted();
  }
  return await new DatabasePreparationSession(
    options,
    createPreparationClient(options.databaseUrl),
  ).prepare();
};
