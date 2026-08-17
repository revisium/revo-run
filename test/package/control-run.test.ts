import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunManagerError } from '../../src/index.js';
import type { RunManager } from '../../src/index.js';
import { packageDatabaseUrl } from './support/package-database-url.js';
import { HoldingExecutor, unknownOutcomeExecutor } from './support/package-executors.js';
import { forkPackageDbosProcess } from './support/package-fork-process.js';
import { firstAnswerGatePlan, scriptTaskPlan } from './support/package-plans.js';
import { newPackageRunId, startPackageRunManager } from './support/package-run-manager.js';

const waitForUnknownAttempt = async (runManager: RunManager, runId: string) =>
  vi.waitFor(
    async () => {
      const details = await runManager.getRunDetails(runId);
      const attempt = details?.attempts.find((entry) => entry.status === 'outcomeUnknown');
      if (attempt === undefined) {
        throw new Error('Unknown outcome was not projected.');
      }
      return attempt;
    },
    { timeout: 15_000 },
  );

const waitForPendingGate = async (runManager: RunManager, runId: string) =>
  vi.waitFor(
    async () => {
      const details = await runManager.getRunDetails(runId);
      const gate = details?.gates.find((entry) => entry.status === 'pending');
      if (gate === undefined) {
        throw new Error('Pending human gate was not projected.');
      }
      return gate;
    },
    { timeout: 10_000 },
  );

describe('public run control', () => {
  let manager: RunManager | undefined;

  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
  });

  it('cancels an in-flight script task and waits for the cancelled snapshot', async () => {
    const executor = new HoldingExecutor();
    manager = await startPackageRunManager(executor);
    const runId = newPackageRunId('pkgCancel');

    await manager.startRun({
      runId,
      executionPlan: scriptTaskPlan(),
      input: { subject: 'cancel' },
    });
    await executor.whenStarted();

    await expect(manager.cancelRun({ runId, actorId: 'operator' })).resolves.toMatchObject({
      status: 'accepted',
    });
    await expect(manager.waitForTerminal(runId, { timeoutMs: 15_000 })).resolves.toMatchObject({
      id: runId,
      status: 'cancelled',
    });
  });

  it('answers a pending first-answer gate and finishes the approved route', async () => {
    manager = await startPackageRunManager();
    const runId = newPackageRunId('pkgGate');
    await manager.startRun({
      runId,
      executionPlan: firstAnswerGatePlan(),
      input: null,
    });

    const pending = await waitForPendingGate(manager, runId);
    expect(pending.answers).toEqual(['approved', 'rejected']);

    const commandId = `cmd_${randomUUID()}`;
    await expect(
      manager.answerGate({
        runId,
        gateInstanceId: pending.id,
        answer: 'approved',
        actorId: 'reviewer',
        actorGroups: [],
        commandId,
      }),
    ).resolves.toEqual({ status: 'accepted', commandId });

    await expect(manager.waitForTerminal(runId, { timeoutMs: 15_000 })).resolves.toMatchObject({
      id: runId,
      status: 'succeeded',
    });

    const details = await manager.getRunDetails(runId);
    const resolved = details?.gates.find((entry) => entry.id === pending.id);
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolution: { kind: 'answered', answer: 'approved' },
    });
  });

  it('rejects cancel for a run that does not exist', async () => {
    manager = await startPackageRunManager();

    const error = await manager
      .cancelRun({ runId: 'pkgMissingCancel', actorId: 'operator' })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RunManagerError);
    expect(error).toMatchObject({ code: 'run_not_found' });
  });

  it('rejects resolveUnknownOutcome when no unknown attempt is pending', async () => {
    manager = await startPackageRunManager();
    const runId = newPackageRunId('pkgUnknownIdle');
    await manager.startRun({
      runId,
      executionPlan: scriptTaskPlan(),
      input: null,
    });
    await manager.waitForTerminal(runId, { timeoutMs: 15_000 });
    const details = await manager.getRunDetails(runId);
    const attemptId = details?.attempts[0]?.id;
    expect(attemptId).toEqual(expect.any(String));
    if (attemptId === undefined) {
      throw new Error('Expected a completed attempt id.');
    }

    await expect(
      manager.resolveUnknownOutcome({
        runId,
        attemptId,
        actorId: 'operator',
        resolution: { kind: 'markFailed' },
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: 'run_already_terminal',
    });
  });

  it('resolves a recovered unknown outcome through the public command', async () => {
    const runId = newPackageRunId('pkgUnknown');
    const worker = fileURLToPath(new URL('./support/unknown-outcome-worker.ts', import.meta.url));
    const child = forkPackageDbosProcess(worker, {
      DATABASE_URL: packageDatabaseUrl(),
      PACKAGE_RUN_ID: runId,
    });
    const stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Unknown-outcome worker did not become ready.'));
      }, 15_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Unknown-outcome worker exited ${String(code)} ${String(signal)}.\n${stderrChunks.join('')}`,
          ),
        );
      });
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });

    manager = await startPackageRunManager(unknownOutcomeExecutor);
    const attempt = await waitForUnknownAttempt(manager, runId);
    await expect(
      manager.resolveUnknownOutcome({
        runId,
        attemptId: attempt.id,
        actorId: 'operator',
        resolution: { kind: 'markFailed' },
      }),
    ).resolves.toMatchObject({ status: 'accepted' });
    await expect(manager.waitForTerminal(runId, { timeoutMs: 15_000 })).resolves.toMatchObject({
      id: runId,
      status: 'failed',
    });
  }, 30_000);
});
