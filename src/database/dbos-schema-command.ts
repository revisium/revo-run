import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  RunManagerDatabasePreparationError,
  type RunManagerDatabasePreparationFailure,
} from '../contracts/database-preparation.js';
import {
  normalizePreparationFailures,
  preparationAborted,
  preparationFailure,
  throwPreparationFailures,
} from './preparation-failures.js';

const dbosPackageName = '@dbos-inc/dbos-sdk';
const dbosPackageVersion = '4.25.14';
const dbosSchemaName = 'dbos';
const databaseUrlEnvironmentName = 'REVO_RUN_DATABASE_URL';
const childTerminationGraceMs = 1_000;
const require = createRequire(import.meta.url);

type DbosManifest = Readonly<{
  name: string;
  version: string;
  bin: Readonly<{ dbos: string }>;
}>;

type SchemaProcessResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

const assertNotAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw preparationAborted();
  }
};

const isContainedPath = (parent: string, candidate: string): boolean => {
  const child = relative(parent, candidate);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

const parseDbosManifest = (source: string): DbosManifest => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw preparationFailure('dbos-cli-resolution');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('name' in value) ||
    value.name !== dbosPackageName ||
    !('version' in value) ||
    value.version !== dbosPackageVersion ||
    !('bin' in value) ||
    typeof value.bin !== 'object' ||
    value.bin === null ||
    !('dbos' in value.bin) ||
    typeof value.bin.dbos !== 'string'
  ) {
    throw preparationFailure('dbos-cli-resolution');
  }
  return { name: value.name, version: value.version, bin: { dbos: value.bin.dbos } };
};

const findDbosPackageDirectory = async (entryPath: string): Promise<string> => {
  const current = dirname(entryPath);
  try {
    const manifest = parseDbosManifest(await readFile(join(current, 'package.json'), 'utf8'));
    if (manifest.name === dbosPackageName) {
      return current;
    }
  } catch {
    // Continue until the manifest containing the resolved public entrypoint is found.
  }
  const parent = dirname(current);
  if (parent === current) {
    throw preparationFailure('dbos-cli-resolution');
  }
  return await findDbosPackageDirectory(current);
};

const resolveDbosCli = async (): Promise<string> => {
  try {
    const entryPath = await realpath(require.resolve(dbosPackageName));
    const packageDirectory = await realpath(await findDbosPackageDirectory(entryPath));
    if (!isContainedPath(packageDirectory, entryPath)) {
      throw preparationFailure('dbos-cli-resolution');
    }
    const manifest = parseDbosManifest(
      await readFile(join(packageDirectory, 'package.json'), 'utf8'),
    );
    const binPath = await realpath(resolve(packageDirectory, manifest.bin.dbos));
    if (!isContainedPath(packageDirectory, binPath) || !(await stat(binPath)).isFile()) {
      throw preparationFailure('dbos-cli-resolution');
    }
    return binPath;
  } catch (error) {
    if (error instanceof RunManagerDatabasePreparationError) {
      throw error;
    }
    throw preparationFailure('dbos-cli-resolution');
  }
};

const childEnvironment = (databaseUrl: string): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('DBOS') && name !== databaseUrlEnvironmentName) {
      environment[name] = value;
    }
  }
  environment[databaseUrlEnvironmentName] = JSON.stringify(databaseUrl);
  return environment;
};

const createPrivateConfiguration = async (): Promise<string> => {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'revo-run-dbos-'));
    await chmod(directory, 0o700);
    await writeFile(
      join(directory, 'dbos-config.yaml'),
      `name: revo-run\nsystem_database_url: \${${databaseUrlEnvironmentName}}\nsystem_database_schema_name: ${dbosSchemaName}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    return directory;
  } catch {
    const primary = preparationFailure('temporary-directory-creation');
    if (directory === undefined) {
      throw primary;
    }
    const cleanup: RunManagerDatabasePreparationFailure[] = [];
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      cleanup.push(preparationFailure('temporary-directory-removal'));
    }
    throwPreparationFailures(primary, cleanup);
    throw primary;
  }
};

const executeDbosSchema = async (
  binPath: string,
  directory: string,
  databaseUrl: string,
  signal: AbortSignal,
): Promise<void> => {
  assertNotAborted(signal);
  const result = await new Promise<SchemaProcessResult>((resolveProcess) => {
    const child = spawn(process.execPath, [binPath, 'schema', '--schema', dbosSchemaName], {
      cwd: directory,
      env: childEnvironment(databaseUrl),
      stdio: 'ignore',
    });
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const settle = (value: SchemaProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (forceTimer !== undefined) {
        clearTimeout(forceTimer);
      }
      signal.removeEventListener('abort', terminate);
      resolveProcess(value);
    };
    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, childTerminationGraceMs);
    };
    child.once('error', () => settle({ exitCode: null, signal: null }));
    child.once('close', (exitCode, childSignal) => settle({ exitCode, signal: childSignal }));
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) {
      terminate();
    }
  });
  if (signal.aborted) {
    throw preparationAborted();
  }
  if (result.exitCode !== 0) {
    throw preparationFailure('dbos-schema-migration', result.exitCode, result.signal);
  }
};

export const runDbosSchemaMigration = async (
  databaseUrl: string,
  signal: AbortSignal,
): Promise<void> => {
  assertNotAborted(signal);
  const binPath = await resolveDbosCli();
  assertNotAborted(signal);
  const directory = await createPrivateConfiguration();
  let primary: RunManagerDatabasePreparationFailure | undefined;
  const cleanup: RunManagerDatabasePreparationFailure[] = [];
  try {
    assertNotAborted(signal);
    await executeDbosSchema(binPath, directory, databaseUrl, signal);
  } catch (error) {
    [primary] = normalizePreparationFailures(error, 'dbos-schema-migration');
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      cleanup.push(preparationFailure('temporary-directory-removal'));
    }
  }
  throwPreparationFailures(primary, cleanup);
};
