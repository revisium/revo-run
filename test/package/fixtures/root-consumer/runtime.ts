import assert from 'node:assert/strict';

import { prepareRunManagerDatabase } from '@revisium/revo-run';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required.');
}

const preparation = await prepareRunManagerDatabase({ databaseUrl });
assert.equal(preparation.schema, 'dbos');
assert.ok(preparation.toVersion > 0);

const deepImport: string = '@revisium/revo-run/composition/agent-port';
await assert.rejects(
  import(deepImport),
  (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
);
