import { afterEach, describe, expect, it } from 'vitest';

import { createRunManager, RunManagerError } from '../../src/index.js';
import type { RunManager } from '../../src/index.js';
import { packageDatabaseUrl } from './support/package-database-url.js';
import { completingExecutor } from './support/package-executors.js';
import { scriptTaskPlan } from './support/package-plans.js';
import { newPackageRunId, startPackageRunManager } from './support/package-run-manager.js';

describe('public startRun', () => {
  let manager: RunManager | undefined;

  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
  });

  it('admits a script task and returns the caller run id', async () => {
    manager = await startPackageRunManager();
    const runId = newPackageRunId('pkgStart');

    await expect(
      manager.startRun({
        runId,
        executionPlan: scriptTaskPlan(),
        input: { subject: 'start' },
      }),
    ).resolves.toEqual({ runId });

    const terminal = await manager.waitForTerminal(runId, { timeoutMs: 15_000 });
    expect(terminal).toMatchObject({ id: runId, status: 'succeeded' });
  });

  it('rejects a second admission for the same run id', async () => {
    manager = await startPackageRunManager();
    const runId = newPackageRunId('pkgConflict');
    const input = {
      runId,
      executionPlan: scriptTaskPlan(),
      input: { subject: 'conflict' },
    };

    await manager.startRun(input);
    const error = await manager.startRun(input).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RunManagerError);
    expect(error).toMatchObject({ code: 'run_id_conflict' });
  });

  it('rejects startRun before the manager is started', async () => {
    manager = createRunManager({
      database: { url: packageDatabaseUrl() },
      executor: completingExecutor,
    });

    await expect(
      manager.startRun({
        runId: newPackageRunId('pkgNotStarted'),
        executionPlan: scriptTaskPlan(),
        input: null,
      }),
    ).rejects.toMatchObject({ code: 'manager_not_started' });
  });
});
