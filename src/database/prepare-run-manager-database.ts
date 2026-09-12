import { Client, type QueryResult, type QueryResultRow } from 'pg';

import type {
  PrepareRunManagerDatabaseOptions,
  PrepareRunManagerDatabaseResult,
  RunManagerDatabasePreparationFailure,
  RunManagerDatabasePreparationStage,
} from '../contracts/database-preparation.js';
import { RunManagerDatabasePreparationAggregateError } from '../contracts/database-preparation.js';
import { validateDatabasePreparationOptions } from './database-preparation-options.js';
import { runDbosSchemaMigration } from './dbos-schema-command.js';
import { forceClosePgClientSocket } from './pg-client-termination.js';
import {
  normalizePreparationFailures,
  preparationAborted,
  preparationFailure,
  throwPreparationFailures,
} from './preparation-failures.js';

const dbosSchemaName = 'dbos';
const advisoryLockKeys = Object.freeze([0x7265_766f, 0x7275_6e01] as const);
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

export const prepareRunManagerDatabase = async (
  rawOptions: PrepareRunManagerDatabaseOptions,
): Promise<PrepareRunManagerDatabaseResult> => {
  const options = validateDatabasePreparationOptions(rawOptions);
  if (options.signal?.aborted === true) {
    throw preparationAborted();
  }

  let client: Client;
  try {
    client = new Client({
      application_name: 'revo-run-database-preparation',
      connectionString: options.databaseUrl,
    });
  } catch {
    throw preparationFailure('database-connection');
  }

  const cancellation = new AbortController();
  let primary: RunManagerDatabasePreparationFailure | undefined;
  const cleanup: RunManagerDatabasePreparationFailure[] = [];
  let locked = false;
  let closing = false;
  let clientFailureRecorded = false;
  let clientEnd: Promise<void> | undefined;
  let phase: PreparationPhase = 'postgresql';
  let result: PrepareRunManagerDatabaseResult | undefined;

  const recordPrimary = (failure: RunManagerDatabasePreparationFailure): void => {
    primary ??= failure;
    if (!cancellation.signal.aborted) {
      cancellation.abort();
    }
  };
  const startClientEnd = (): Promise<void> => {
    if (clientEnd === undefined) {
      try {
        clientEnd = client.end().catch(() => {
          cleanup.push(preparationFailure('database-connection-close'));
        });
      } catch {
        cleanup.push(preparationFailure('database-connection-close'));
        clientEnd = Promise.resolve();
      }
    }
    return clientEnd;
  };
  const endClient = (force = false): Promise<void> => {
    const ending = startClientEnd();
    if (force) {
      try {
        forceClosePgClientSocket(client);
      } catch {
        cleanup.push(preparationFailure('database-connection-close'));
      }
    }
    return ending;
  };
  const onExternalAbort = (): void => {
    recordPrimary(preparationAborted());
    if (phase !== 'dbos-child') {
      void endClient(true);
    }
  };
  const onClientError = (): void => {
    if (clientFailureRecorded) {
      return;
    }
    clientFailureRecorded = true;
    const failure = preparationFailure(
      closing ? 'database-connection-close' : 'database-session-lost',
    );
    if (closing) {
      cleanup.push(failure);
    } else {
      recordPrimary(failure);
      void endClient(true);
    }
  };
  client.on('error', onClientError);
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const runPgOperation = async <Value>(
    operation: () => Promise<Value>,
    failureStage: RunManagerDatabasePreparationStage,
  ): Promise<Value> => {
    if (cancellation.signal.aborted) {
      await endClient(true);
      throw primary ?? preparationAborted();
    }
    let rejectCancellation: ((reason: RunManagerDatabasePreparationFailure) => void) | undefined;
    const cancellationResult = new Promise<Value>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onCancellation = (): void => {
      void endClient(true).then(() => rejectCancellation?.(primary ?? preparationAborted()));
    };
    cancellation.signal.addEventListener('abort', onCancellation, { once: true });
    if (cancellation.signal.aborted) {
      onCancellation();
    }
    try {
      return await Promise.race([Promise.resolve().then(operation), cancellationResult]);
    } catch (error) {
      if (cancellation.signal.aborted) {
        throw primary ?? preparationAborted();
      }
      const [failure] = normalizePreparationFailures(error, failureStage);
      throw failure ?? preparationFailure(failureStage);
    } finally {
      cancellation.signal.removeEventListener('abort', onCancellation);
    }
  };
  const query: PgQuery = async <Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> =>
    await runPgOperation(
      async () => await client.query<Row>(text, values === undefined ? [] : [...values]),
      text.startsWith('SELECT pg_try_advisory_lock')
        ? 'advisory-lock-acquisition'
        : 'migration-version-read',
    );

  try {
    try {
      await runPgOperation(async () => await client.connect(), 'database-connection');
      while (!locked) {
        const lock = await query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock($1, $2) AS acquired',
          advisoryLockKeys,
        );
        locked = lock.rows[0]?.acquired === true;
        if (!locked) {
          await abortableDelay(cancellation.signal);
        }
      }
      const fromVersion = await readMigrationVersion(query);
      phase = 'dbos-child';
      await runDbosSchemaMigration(options.databaseUrl, cancellation.signal);
      phase = 'postgresql';
      const toVersion = await readMigrationVersion(query);
      result = {
        schema: dbosSchemaName,
        fromVersion,
        toVersion,
        migrated: toVersion !== fromVersion,
      };
    } catch (error) {
      if (error instanceof RunManagerDatabasePreparationAggregateError) {
        if (error.primary !== undefined && primary === undefined) {
          recordPrimary(error.primary);
        }
        cleanup.push(...error.cleanup);
      } else {
        const [failure] = normalizePreparationFailures(error, 'dbos-schema-migration');
        if (failure !== undefined && primary === undefined) {
          recordPrimary(failure);
        }
      }
    } finally {
      closing = true;
      phase = 'cleanup';
      if (locked && clientEnd === undefined) {
        try {
          await client.query('SELECT pg_advisory_unlock($1, $2)', [...advisoryLockKeys]);
        } catch (error) {
          cleanup.push(...normalizePreparationFailures(error, 'advisory-lock-release'));
        }
      }
      await endClient();
    }
  } finally {
    options.signal?.removeEventListener('abort', onExternalAbort);
    client.removeListener('error', onClientError);
  }

  throwPreparationFailures(primary, cleanup);
  if (result === undefined) {
    throw preparationFailure('dbos-schema-migration');
  }
  return result;
};
