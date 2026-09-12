import { getEventListeners } from 'node:events';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  RunManagerDatabasePreparationAbortedError,
  RunManagerDatabasePreparationAggregateError,
  RunManagerDatabasePreparationError,
  prepareRunManagerDatabase,
} from '../../src/index.js';

const serializedError = (error: unknown): string => {
  return error instanceof Error
    ? JSON.stringify({
        message: error.message,
        stack: error.stack,
        code: error instanceof RunManagerDatabasePreparationError ? error.code : undefined,
        stage: error instanceof RunManagerDatabasePreparationError ? error.stage : undefined,
      })
    : JSON.stringify(error);
};

describe('run-manager database preparation failures', () => {
  it.each([undefined, null])(
    'rejects missing options %s through input validation',
    async (options) => {
      await expect(Reflect.apply(prepareRunManagerDatabase, undefined, [options])).rejects.toEqual(
        expect.objectContaining({
          code: 'run_manager_database_preparation_failed',
          stage: 'input-validation',
        }),
      );
    },
  );

  it.each([
    {},
    { databaseUrl: 'postgresql://user:secret@example.invalid/database', signal: null },
    { databaseUrl: 'postgresql://user:secret@example.invalid/database', unexpected: true },
  ])('rejects the complete invalid options shape %#', async (options) => {
    await expect(Reflect.apply(prepareRunManagerDatabase, undefined, [options])).rejects.toEqual(
      expect.objectContaining({
        code: 'run_manager_database_preparation_failed',
        stage: 'input-validation',
      }),
    );
  });

  it('rejects invalid input through the closed public error', async () => {
    await expect(
      prepareRunManagerDatabase({ databaseUrl: 'not-a-postgresql-url' }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'run_manager_database_preparation_failed',
        stage: 'input-validation',
      }),
    );
  });

  it('returns the dedicated closed error when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      prepareRunManagerDatabase({
        databaseUrl: 'postgresql://user:secret@example.invalid/database',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunManagerDatabasePreparationAbortedError);
  });

  it('redacts an unreachable database URL', async () => {
    const sentinel = 'revo-run-secret-sentinel';
    let failure: unknown;

    try {
      await prepareRunManagerDatabase({
        databaseUrl: `postgresql://user:${sentinel}@127.0.0.1:1/database?connect_timeout=1`,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RunManagerDatabasePreparationError);
    expect(failure).toEqual(
      expect.objectContaining({
        code: 'run_manager_database_preparation_failed',
        stage: 'database-connection',
      }),
    );
    expect(serializedError(failure)).not.toContain(sentinel);
  });

  it('normalizes a synchronous pg client construction failure and removes no listener', async () => {
    const sentinel = 'synchronous-client-secret-sentinel';
    const controller = new AbortController();
    const databaseUrl = new URL('postgresql://user:password@127.0.0.1/database');
    databaseUrl.searchParams.set('sslrootcert', `/definitely-missing/${sentinel}.pem`);

    let failure: unknown;
    try {
      await prepareRunManagerDatabase({
        databaseUrl: databaseUrl.toString(),
        signal: controller.signal,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'run_manager_database_preparation_failed',
      stage: 'database-connection',
    });
    expect(serializedError(failure)).not.toContain(sentinel);
    expect(getEventListeners(controller.signal, 'abort')).toStrictEqual([]);
  });

  it('aborts an accepted but silent PostgreSQL handshake and closes its socket', async () => {
    let accepted: (() => void) | undefined;
    const connectionAccepted = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      accepted?.();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Silent PostgreSQL test server did not expose a TCP port.');
      }
      const controller = new AbortController();
      const preparation = prepareRunManagerDatabase({
        databaseUrl: `postgresql://user:secret@127.0.0.1:${address.port}/database`,
        signal: controller.signal,
      });
      await connectionAccepted;
      controller.abort();

      let timeout: NodeJS.Timeout | undefined;
      try {
        await expect(
          Promise.race([
            preparation,
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Silent handshake abort timed out.')),
                1_500,
              );
            }),
          ]),
        ).rejects.toBeInstanceOf(RunManagerDatabasePreparationAbortedError);
      } finally {
        clearTimeout(timeout);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(sockets.size).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toStrictEqual([]);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it('orders a primary failure before typed cleanup failures', () => {
    const primary = new RunManagerDatabasePreparationError('database-session-lost');
    const cleanup = new RunManagerDatabasePreparationError('database-connection-close');
    const aggregate = new RunManagerDatabasePreparationAggregateError(primary, [cleanup]);

    expect(aggregate.code).toBe('run_manager_database_preparation_cleanup_failed');
    expect(aggregate.primary).toBe(primary);
    expect(aggregate.cleanup).toStrictEqual([cleanup]);
    expect(aggregate.errors).toStrictEqual([primary, cleanup]);
    expect(aggregate.errors.every((error) => error instanceof Error)).toBe(true);
  });
});
