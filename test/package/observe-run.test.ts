import { afterEach, describe, expect, it } from 'vitest';

import { RunManagerError } from '../../src/index.js';
import type { RunManager } from '../../src/index.js';
import { scriptTaskPlan } from './support/package-plans.js';
import { newPackageRunId, startPackageRunManager } from './support/package-run-manager.js';

describe('public run observation', () => {
  let manager: RunManager | undefined;

  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
  });

  it('returns the admitted snapshot', async () => {
    manager = await startPackageRunManager();
    const runId = newPackageRunId('pkgGet');
    await manager.startRun({
      runId,
      executionPlan: scriptTaskPlan(),
      input: { subject: 'get' },
    });

    const started = await manager.getRun(runId);
    expect(started?.id).toBe(runId);
    expect(['pending', 'running', 'succeeded']).toContain(started?.status);
  });

  it('projects completed details for a succeeded script task', async () => {
    manager = await startPackageRunManager();
    const runId = newPackageRunId('pkgDetails');
    await manager.startRun({
      runId,
      executionPlan: scriptTaskPlan(),
      input: { subject: 'details' },
    });
    await manager.waitForTerminal(runId, { timeoutMs: 15_000 });

    const details = await manager.getRunDetails(runId);
    expect(details?.run).toMatchObject({ id: runId, status: 'succeeded' });
    expect(details?.scopes.some((scope) => scope.kind === 'root')).toBe(true);
    expect(details?.nodeInstances.length).toBeGreaterThan(0);
    expect(details?.attempts.length).toBeGreaterThan(0);
    expect(details?.attempts.every((attempt) => attempt.status === 'completed')).toBe(true);
  });

  it('resolves undefined for an unknown run id', async () => {
    manager = await startPackageRunManager();
    await expect(manager.getRun('pkgMissingRun')).resolves.toBeUndefined();
    await expect(manager.getRunDetails('pkgMissingDetails')).resolves.toBeUndefined();
  });

  it('returns the terminal snapshot from waitForTerminal', async () => {
    manager = await startPackageRunManager();
    const runId = newPackageRunId('pkgWait');
    await manager.startRun({
      runId,
      executionPlan: scriptTaskPlan(),
      input: { subject: 'wait' },
    });

    const terminal = await manager.waitForTerminal(runId, { timeoutMs: 15_000 });
    expect(terminal.status).toBe('succeeded');
    if (terminal.status !== 'succeeded') {
      throw new Error('Expected a succeeded snapshot.');
    }
    expect(terminal.result.outcome).toBe('completed');
  });

  it('rejects a zero wait timeout before polling', async () => {
    manager = await startPackageRunManager();

    const error = await manager
      .waitForTerminal('pkgWaitInvalid', { timeoutMs: 0 })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RunManagerError);
    expect(error).toMatchObject({ code: 'invalid_wait_for_terminal_input' });
  });
});
