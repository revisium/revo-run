import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { forkTestDbosProcess } from './process/fork-test-dbos-process.js';

const preparationWorker = fileURLToPath(
  new URL('./process/database-preparation-worker.ts', import.meta.url),
);

export type PreparationResult = Readonly<{
  schema: 'dbos';
  fromVersion: number;
  toVersion: number;
  migrated: boolean;
}>;

export type PreparationWorkerResult =
  | Readonly<{ outcome: 'prepared'; result: PreparationResult }>
  | Readonly<{ outcome: 'rejected'; error: unknown }>;

const isPreparationResult = (value: unknown): value is PreparationResult =>
  typeof value === 'object' &&
  value !== null &&
  'schema' in value &&
  value.schema === 'dbos' &&
  'fromVersion' in value &&
  typeof value.fromVersion === 'number' &&
  'toVersion' in value &&
  typeof value.toVersion === 'number' &&
  'migrated' in value &&
  typeof value.migrated === 'boolean';

const isPreparationWorkerResult = (value: unknown): value is PreparationWorkerResult => {
  if (typeof value !== 'object' || value === null || !('outcome' in value)) {
    return false;
  }
  if (value.outcome === 'prepared') {
    return 'result' in value && isPreparationResult(value.result);
  }
  return value.outcome === 'rejected' && 'error' in value;
};

export const runPreparationWorker = async (
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<PreparationWorkerResult> => {
  const child = forkTestDbosProcess(preparationWorker, {
    applicationVersion: `database-preparation-${randomUUID()}`,
    env: { ...environment, REVO_RUN_PREPARATION_TEST_DATABASE_URL: databaseUrl },
  });
  let result: unknown;
  child.once('message', (message: unknown) => {
    result = message;
  });
  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once('exit', (childExitCode, childSignal) =>
      resolveExit({ exitCode: childExitCode, signal: childSignal }),
    );
  });
  if (signal !== null || exitCode !== 0) {
    throw new Error('Database preparation worker did not exit cleanly.');
  }
  if (!isPreparationWorkerResult(result)) {
    throw new Error('Database preparation worker returned an invalid result.');
  }
  return result;
};

export const prepareInWorker = async (databaseUrl: string): Promise<PreparationResult> => {
  const result = await runPreparationWorker(databaseUrl);
  if (result.outcome !== 'prepared') {
    throw new Error('Database preparation worker unexpectedly rejected preparation.');
  }
  return result.result;
};
