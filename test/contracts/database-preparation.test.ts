import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  RunManagerDatabasePreparationAbortedError,
  RunManagerDatabasePreparationError,
  prepareRunManagerDatabase,
} from '../../src/index.js';

describe('prepareRunManagerDatabase input', () => {
  it.each([
    undefined,
    null,
    {},
    { databaseUrl: 'not-a-url' },
    { databaseUrl: 'https://example.invalid/database' },
    { databaseUrl: 'postgresql://example.invalid' },
    { databaseUrl: 'postgresql:///database' },
    { databaseUrl: 'postgresql://example.invalid/database', signal: null },
  ])('rejects invalid input %#', async (input) => {
    await expect(
      Reflect.apply(prepareRunManagerDatabase, undefined, [input]),
    ).rejects.toMatchObject({
      code: 'run_manager_database_preparation_failed',
      stage: 'input-validation',
    });
  });

  it('rejects an already-aborted operation', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      prepareRunManagerDatabase({
        databaseUrl: 'postgresql://user:secret@example.invalid/database',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunManagerDatabasePreparationAbortedError);
  });

  it('does not expose credentials when the database is unavailable', async () => {
    const password = 'database-password-sentinel';
    let failure: unknown;

    try {
      await prepareRunManagerDatabase({
        databaseUrl: `postgresql://user:${password}@127.0.0.1:1/database?connect_timeout=1`,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RunManagerDatabasePreparationError);
    expect(failure).toMatchObject({ stage: 'database-connection' });
    expect(JSON.stringify(failure)).not.toContain(password);
  });

  it('cancels a PostgreSQL connection handshake', async () => {
    let connectionAccepted: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => {
      connectionAccepted = resolve;
    });
    const server = createServer((socket) => {
      socket.on('error', () => undefined);
      connectionAccepted?.();
    });
    await new Promise<void>((resolve, reject) =>
      server.listen(0, '127.0.0.1', resolve).on('error', reject),
    );

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Test server has no TCP port.');
      }
      const controller = new AbortController();
      const preparation = prepareRunManagerDatabase({
        databaseUrl: `postgresql://user:secret@127.0.0.1:${address.port}/database`,
        signal: controller.signal,
      });
      await accepted;
      controller.abort();

      await expect(preparation).rejects.toBeInstanceOf(RunManagerDatabasePreparationAbortedError);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});
