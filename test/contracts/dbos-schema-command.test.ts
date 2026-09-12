import { describe, expect, it } from 'vitest';

import {
  RunManagerDatabasePreparationAbortedError,
  RunManagerDatabasePreparationError,
} from '../../src/contracts/database-preparation.js';
import {
  childEnvironment,
  isContainedPath,
  parseDbosManifest,
  runDbosSchemaMigration,
} from '../../src/database/dbos-schema-command.js';
import { forceClosePgClientSocket } from '../../src/database/pg-client-termination.js';

const validManifest = {
  name: '@dbos-inc/dbos-sdk',
  version: '4.25.14',
  bin: { dbos: 'dist/src/dbos-runtime/cli.js' },
};

describe('DBOS schema command boundaries', () => {
  it('accepts only the exact pinned public DBOS bin manifest', () => {
    expect(parseDbosManifest(JSON.stringify(validManifest))).toStrictEqual(validManifest);

    const invalid = [
      'not-json',
      JSON.stringify(null),
      JSON.stringify({}),
      JSON.stringify({ name: validManifest.name }),
      JSON.stringify({ name: validManifest.name, version: validManifest.version }),
      JSON.stringify({ ...validManifest, name: 'other' }),
      JSON.stringify({ ...validManifest, version: '4.25.15' }),
      JSON.stringify({ ...validManifest, bin: null }),
      JSON.stringify({ ...validManifest, bin: {} }),
      JSON.stringify({ ...validManifest, bin: { dbos: 1 } }),
    ];
    for (const source of invalid) {
      expect(() => parseDbosManifest(source)).toThrow(
        expect.objectContaining<Partial<RunManagerDatabasePreparationError>>({
          stage: 'dbos-cli-resolution',
        }),
      );
    }
  });

  it('rejects a pre-aborted migration before resolving or spawning DBOS', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runDbosSchemaMigration(
        'postgresql://user:secret@example.invalid/database',
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(RunManagerDatabasePreparationAbortedError);
  });

  it('rejects same, parent-escaping, and sibling paths', () => {
    expect(isContainedPath('/package', '/package/dist/cli.js')).toBe(true);
    expect(isContainedPath('/package', '/package')).toBe(false);
    expect(isContainedPath('/package', '/outside/cli.js')).toBe(false);
    expect(isContainedPath('/package', '/package-sibling/cli.js')).toBe(false);
  });

  it('sanitizes conflicting DBOS variables and JSON-encodes the URL', () => {
    const databaseUrl = 'postgresql://user:secret@127.0.0.1/database?option=one two';
    expect(
      childEnvironment(databaseUrl, {
        DBOS_DATABASE_URL: 'cloud-secret',
        DBOSCLOUD_HOST: 'cloud.example',
        KEEP_ME: 'safe',
        REVO_RUN_DATABASE_URL: 'conflict',
      }),
    ).toStrictEqual({
      KEEP_ME: 'safe',
      REVO_RUN_DATABASE_URL: JSON.stringify(databaseUrl),
    });
  });

  it('fails closed when the pinned pg stream shape is unavailable', () => {
    expect(() => {
      Reflect.apply(forceClosePgClientSocket, undefined, [{}]);
    }).toThrow(TypeError);
  });
});
