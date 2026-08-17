import { randomUUID } from 'node:crypto';

import { createRunManager } from '../../../src/index.js';
import type { RunExecutor, RunManager } from '../../../src/index.js';
import { packageDatabaseUrl } from './package-database-url.js';
import { completingExecutor } from './package-executors.js';

export const newPackageRunId = (prefix: string): string => `${prefix}_${randomUUID()}`;

export const startPackageRunManager = async (
  executor: RunExecutor = completingExecutor,
): Promise<RunManager> => {
  const manager = createRunManager({
    database: { url: packageDatabaseUrl() },
    executor,
  });
  await manager.start();
  return manager;
};
