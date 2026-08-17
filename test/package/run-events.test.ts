import { afterEach, describe, expect, it } from 'vitest';

import { RunManagerError } from '../../src/index.js';
import type { RunManager } from '../../src/index.js';
import { collectRunEvents } from './support/collect-run-events.js';
import { parallelPlan, scriptTaskPlan } from './support/package-plans.js';
import { newPackageRunId, startPackageRunManager } from './support/package-run-manager.js';

describe('public run events', () => {
  let manager: RunManager | undefined;

  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
  });

  it('streams a totally ordered live subscription that matches the event page', async () => {
    manager = await startPackageRunManager();
    const runId = newPackageRunId('pkgLiveEvents');
    await manager.startRun({
      runId,
      executionPlan: scriptTaskPlan(),
      input: { subject: 'live-events' },
    });

    const liveEvents = collectRunEvents(manager, runId);
    await manager.waitForTerminal(runId, { timeoutMs: 15_000 });
    const events = await liveEvents;

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]?.type).toBe('nodeExecution.started');
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.map((event) => event.cursor)).toEqual(
      events.map((_, index) => `${runId}:${String(index + 1)}`),
    );

    const page = await manager.getRunEvents(runId);
    expect(page.hasMore).toBe(false);
    expect(page.items.map((event) => event.type)).toEqual(events.map((event) => event.type));
  });

  it('pages events and replays the remainder through subscribe after the cursor', async () => {
    manager = await startPackageRunManager();
    const runId = newPackageRunId('pkgEventPage');
    await manager.startRun({
      runId,
      executionPlan: scriptTaskPlan(),
      input: { subject: 'event-page' },
    });
    await manager.waitForTerminal(runId, { timeoutMs: 15_000 });

    const firstPage = await manager.getRunEvents(runId, { limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    const nextCursor = firstPage.nextCursor;
    expect(nextCursor).toEqual(expect.any(String));
    if (nextCursor === undefined) {
      throw new Error('Expected an event continuation cursor.');
    }

    const remainder = await manager.getRunEvents(runId, {
      after: nextCursor,
      limit: 100,
    });
    expect(remainder.hasMore).toBe(false);
    expect(remainder.items.length).toBeGreaterThan(0);

    const replayed = await collectRunEvents(manager, runId);
    expect(replayed.map((event) => event.cursor)).toEqual(
      [...firstPage.items, ...remainder.items].map((event) => event.cursor),
    );

    const afterCursor = await collectRunEvents(manager, runId, nextCursor);
    expect(afterCursor.map((event) => event.cursor)).toEqual(
      remainder.items.map((event) => event.cursor),
    );
  });

  it('live-subscribes a parallel join through run.completed', async () => {
    manager = await startPackageRunManager();
    const runManager = manager;
    const runId = newPackageRunId('pkgParallelEvents');
    await runManager.startRun({
      runId,
      executionPlan: parallelPlan(),
      input: null,
    });

    const liveEvents = collectRunEvents(runManager, runId);
    await runManager.waitForTerminal(runId, { timeoutMs: 20_000 });
    const events = await liveEvents;

    expect(events.filter((event) => event.type === 'nodeExecution.started').length).toBeGreaterThan(
      1,
    );
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.map((event) => event.cursor)).toEqual(
      events.map((_, index) => `${runId}:${String(index + 1)}`),
    );
  });

  it('rejects a malformed event cursor before reading', async () => {
    manager = await startPackageRunManager();
    const runId = newPackageRunId('pkgBadCursor');
    await manager.startRun({
      runId,
      executionPlan: scriptTaskPlan(),
      input: null,
    });
    await manager.waitForTerminal(runId, { timeoutMs: 15_000 });

    const error = await manager
      .getRunEvents(runId, { after: `${runId}:01` })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RunManagerError);
    expect(error).toMatchObject({ code: 'invalid_run_event_cursor' });
  });

  it('rejects event reads for a run that does not exist', async () => {
    manager = await startPackageRunManager();

    await expect(manager.getRunEvents('pkgMissingEvents')).rejects.toMatchObject({
      code: 'run_not_found',
    });
  });
});
