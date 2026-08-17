import { afterEach, describe, expect, it } from 'vitest';

import { RunManagerError } from '../../src/index.js';
import type { RunManager } from '../../src/index.js';
import { listSucceededIds } from './support/list-succeeded-ids.js';
import { scriptTaskPlan } from './support/package-plans.js';
import { newPackageRunId, startPackageRunManager } from './support/package-run-manager.js';

describe('public listRuns', () => {
  let manager: RunManager | undefined;

  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
  });

  it('finds succeeded runs in the creation window', async () => {
    manager = await startPackageRunManager();
    const createdFrom = new Date(Date.now() - 1_000);
    const firstRunId = newPackageRunId('pkgListA');
    const secondRunId = newPackageRunId('pkgListB');

    await manager.startRun({
      runId: firstRunId,
      executionPlan: scriptTaskPlan(),
      input: { subject: 'list-a' },
    });
    await manager.startRun({
      runId: secondRunId,
      executionPlan: scriptTaskPlan(),
      input: { subject: 'list-b' },
    });
    await Promise.all([
      manager.waitForTerminal(firstRunId, { timeoutMs: 15_000 }),
      manager.waitForTerminal(secondRunId, { timeoutMs: 15_000 }),
    ]);

    const listedIds = await listSucceededIds(manager, createdFrom, new Date(Date.now() + 1_000));
    expect(listedIds).toEqual(expect.arrayContaining([firstRunId, secondRunId]));
  });

  it('continues from the raw list offset', async () => {
    manager = await startPackageRunManager();
    const createdFrom = new Date(Date.now() - 1_000);
    const firstRunId = newPackageRunId('pkgListPageA');
    const secondRunId = newPackageRunId('pkgListPageB');
    await manager.startRun({
      runId: firstRunId,
      executionPlan: scriptTaskPlan(),
      input: null,
    });
    await manager.startRun({
      runId: secondRunId,
      executionPlan: scriptTaskPlan(),
      input: null,
    });
    await Promise.all([
      manager.waitForTerminal(firstRunId, { timeoutMs: 15_000 }),
      manager.waitForTerminal(secondRunId, { timeoutMs: 15_000 }),
    ]);

    const createdThrough = new Date(Date.now() + 1_000);
    const firstPage = await manager.listRuns({
      statuses: ['succeeded'],
      createdFrom,
      createdThrough,
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    const nextOffset = firstPage.nextOffset;
    expect(nextOffset).toEqual(expect.any(Number));
    if (nextOffset === undefined) {
      throw new Error('Expected a list continuation offset.');
    }

    const secondPage = await manager.listRuns({
      statuses: ['succeeded'],
      createdFrom,
      createdThrough,
      offset: nextOffset,
      limit: 1,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
  });

  it('rejects an empty status filter before reading', async () => {
    manager = await startPackageRunManager();

    const error = await manager.listRuns({ statuses: [] }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RunManagerError);
    expect(error).toMatchObject({ code: 'invalid_list_runs_input' });
  });
});
