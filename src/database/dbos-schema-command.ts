import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { RunManagerDatabasePreparationFailure } from '../contracts/database-preparation.js';
import {
  normalizePreparationFailures,
  preparationAborted,
  preparationFailure,
} from './preparation-failures.js';

const dbosPackageName = '@dbos-inc/dbos-sdk';
const databaseUrlEnvironmentName = 'REVO_RUN_DATABASE_URL';
const childTerminationGraceMs = 1_000;
const require = createRequire(import.meta.url);

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw preparationAborted();
  }
};

const resolveDbosCli = async (): Promise<string> => {
  let directory: string;
  try {
    directory = dirname(require.resolve(dbosPackageName));
  } catch {
    throw preparationFailure('dbos-cli-resolution');
  }

  while (true) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Package parents must be inspected in order.
      const manifest: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (
        typeof manifest === 'object' &&
        manifest !== null &&
        'name' in manifest &&
        manifest.name === dbosPackageName &&
        'bin' in manifest &&
        typeof manifest.bin === 'object' &&
        manifest.bin !== null &&
        'dbos' in manifest.bin &&
        typeof manifest.bin.dbos === 'string'
      ) {
        return resolve(directory, manifest.bin.dbos);
      }
    } catch {
      // The resolved entrypoint may be nested several directories below the package manifest.
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw preparationFailure('dbos-cli-resolution');
    }
    directory = parent;
  }
};

const migrationEnvironment = (databaseUrl: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DBOS'))),
  [databaseUrlEnvironmentName]: JSON.stringify(databaseUrl),
});

const runSchemaCommand = async (
  cli: string,
  cwd: string,
  databaseUrl: string,
  signal: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);

  const child = spawn(process.execPath, [cli, 'schema', '--schema', 'dbos'], {
    cwd,
    env: migrationEnvironment(databaseUrl),
    stdio: 'ignore',
  });

  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      let forceTimer: NodeJS.Timeout | undefined;
      const stop = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        child.kill('SIGTERM');
        forceTimer ??= setTimeout(() => child.kill('SIGKILL'), childTerminationGraceMs);
      };
      const finish = (exitCode: number | null, childSignal: NodeJS.Signals | null): void => {
        clearTimeout(forceTimer);
        signal.removeEventListener('abort', stop);
        resolveExit({ exitCode, signal: childSignal });
      };

      child.once('error', () => finish(null, null));
      child.once('close', finish);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) {
        stop();
      }
    },
  );

  throwIfAborted(signal);
  if (result.exitCode !== 0) {
    throw preparationFailure('dbos-schema-migration', result.exitCode, result.signal);
  }
};

export const runDbosSchemaMigration = async (
  databaseUrl: string,
  signal: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);

  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), 'revo-run-dbos-'));
    await writeFile(
      join(directory, 'dbos-config.yaml'),
      `name: revo-run\nsystem_database_url: \${${databaseUrlEnvironmentName}}\nsystem_database_schema_name: dbos\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
  } catch {
    throw preparationFailure('dbos-schema-migration');
  }

  let failure: RunManagerDatabasePreparationFailure | undefined;
  try {
    await runSchemaCommand(await resolveDbosCli(), directory, databaseUrl, signal);
  } catch (error) {
    failure = normalizePreparationFailures(error, 'dbos-schema-migration');
  }

  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    failure ??= preparationFailure('cleanup');
  }

  if (failure !== undefined) {
    throw failure;
  }
};
