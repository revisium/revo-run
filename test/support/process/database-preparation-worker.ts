import {
  RunManagerDatabasePreparationAbortedError,
  RunManagerDatabasePreparationError,
  prepareRunManagerDatabase,
} from '../../../src/index.js';

const databaseUrl = process.env['REVO_RUN_PREPARATION_TEST_DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('REVO_RUN_PREPARATION_TEST_DATABASE_URL is required.');
}
const childNodeOptions = process.env['REVO_RUN_PREPARATION_CHILD_NODE_OPTIONS'];
if (childNodeOptions !== undefined) {
  process.env['NODE_OPTIONS'] = childNodeOptions;
}
const serializeFailure = (error: unknown): unknown => {
  if (error instanceof RunManagerDatabasePreparationError) {
    return {
      code: error.code,
      exitCode: error.exitCode,
      message: error.message,
      name: error.name,
      signal: error.signal,
      stage: error.stage,
    };
  }
  if (error instanceof RunManagerDatabasePreparationAbortedError) {
    return { code: error.code, message: error.message, name: error.name };
  }
  return { code: 'unexpected_failure' };
};

let message: unknown;
try {
  message = {
    outcome: 'prepared',
    result: await prepareRunManagerDatabase({ databaseUrl }),
  };
} catch (error) {
  message = { outcome: 'rejected', error: serializeFailure(error) };
}

await new Promise<void>((resolve, reject) => {
  if (process.send === undefined) {
    reject(new Error('Database preparation worker requires an IPC channel.'));
    return;
  }
  process.send(message, (error) => (error === null ? resolve() : reject(error)));
});
process.disconnect();
