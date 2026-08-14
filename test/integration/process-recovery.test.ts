import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { isNodeEffectDecisionStepName } from '../../src/dbos/dbos-names.js';
import {
  RecoveryProcess,
  type RecoveryProcessOptions,
  type RecoveryWorkerMessage,
} from '../support/process/recovery-process.js';
import { RetryBackoffRecords } from '../support/process/retry-backoff-records.js';

const delayDurationMs = 5_000;

const expectNoDispatchBefore = async (
  process: RecoveryProcess,
  path: string,
  attemptOrdinal: number,
  deadlineEpochMs: number,
): Promise<void> => {
  const remainingMs = deadlineEpochMs - Date.now();
  if (remainingMs <= 0) {
    return;
  }
  expect(process.dispatched(path, attemptOrdinal)).toBe(0);
  await wait(Math.min(20, remainingMs));
  await expectNoDispatchBefore(process, path, attemptOrdinal, deadlineEpochMs);
};

describe('process recovery', () => {
  it('does not dispatch a checkpointed task after a process crash', async () => {
    const runId = `process-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId);
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/first' });
      firstProcess.complete('main/first');
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/second' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId);
      await recoveredProcess.waitFor({
        kind: 'dispatched',
        path: 'main/second',
        attemptOrdinal: 2,
      });
      expect(recoveredProcess.dispatched('main/first')).toBe(0);

      recoveredProcess.complete('main/second');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'events' });
      const events = recoveredProcess.eventStream();
      expect(events.types).toStrictEqual([
        'nodeExecution.started',
        'nodeExecution.completed',
        'nodeExecution.started',
        'nodeExecution.failed',
        'nodeExecution.started',
        'nodeExecution.completed',
        'run.completed',
      ]);
      expect(events.cursors).toStrictEqual(
        events.cursors.map((_, index) => `${runId}:${index + 1}`),
      );
      expect(new Set(events.cursors).size).toBe(events.cursors.length);
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);

  it('routes a checkpointed timeout identically after a process crash', async () => {
    const runId = `timeout-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'timeout');
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'timeoutSignalled', path: 'main/work' });
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/after-timeout' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'timeout');
      await recoveredProcess.waitFor({
        kind: 'dispatched',
        path: 'main/after-timeout',
        attemptOrdinal: 2,
      });
      expect(recoveredProcess.dispatched('main/work')).toBe(0);

      recoveredProcess.complete('main/after-timeout');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);

  it('resumes a durable retry delay after a process crash', async () => {
    const runId = `retry-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'retry');
    const records = await RetryBackoffRecords.connect();
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({
        kind: 'dispatched',
        path: 'main/work',
        attemptOrdinal: 1,
      });
      await firstProcess.waitFor({ kind: 'checkpointed', path: 'main/work' });
      const sleepBeforeCrash = await records.waitForPositiveDurationSleep(runId);
      expect(sleepBeforeCrash.deadlineEpochMs).toBeGreaterThan(Date.now());
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'retry');
      await recoveredProcess.waitFor({ kind: 'ready' });
      const sleepAfterRecovery = await records.waitForPositiveDurationSleep(runId);
      expect(sleepAfterRecovery).toStrictEqual(sleepBeforeCrash);
      expect(recoveredProcess.dispatched('main/work', 1)).toBe(0);
      await expectNoDispatchBefore(
        recoveredProcess,
        'main/work',
        2,
        sleepBeforeCrash.deadlineEpochMs,
      );

      await recoveredProcess.waitFor({
        kind: 'dispatched',
        path: 'main/work',
        attemptOrdinal: 2,
      });
      await wait(100);
      expect(recoveredProcess.dispatched('main/work', 2)).toBe(1);

      recoveredProcess.complete('main/work');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      const operations = await records.operationsForRun(runId);
      const retrySleeps = await records.retryBackoffSleepsForRun(runId);
      expect(retrySleeps).toStrictEqual([
        expect.objectContaining({
          functionID: sleepBeforeCrash.functionID,
          startedAtEpochMs: sleepBeforeCrash.startedAtEpochMs,
          deadlineEpochMs: sleepBeforeCrash.deadlineEpochMs,
        }),
      ]);
      expect(
        operations.filter(({ name }) => isNodeEffectDecisionStepName(name)).map(({ name }) => name),
      ).toStrictEqual(['node-effect-decision:1:main/work', 'node-effect-decision:2:main/work']);
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      try {
        await firstProcess.kill();
        await recoveredProcess?.kill();
      } finally {
        await records.close();
      }
    }
  }, 30_000);

  it('retains a durable delay deadline across a process crash', async () => {
    const runId = `delay-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'delay');
    const records = await RetryBackoffRecords.connect();
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'delayWaiting' });
      const sleepBeforeCrash = await records.waitForDurationSleep(runId, delayDurationMs);
      expect(sleepBeforeCrash.deadlineEpochMs).toBeGreaterThan(Date.now());
      await wait(2_500);
      expect(sleepBeforeCrash.deadlineEpochMs).toBeGreaterThan(Date.now());
      expect(firstProcess.count('terminal')).toBe(0);
      const firstProcessExit = firstProcess.kill();
      await firstProcessExit;

      recoveredProcess = new RecoveryProcess('recover', runId, 'delay');
      await recoveredProcess.waitFor({
        kind: 'ready',
        applicationVersion: firstProcess.applicationVersion,
      });
      const recoveredReadyAt = Date.now();
      const sleepAfterRecovery = await records.waitForDurationSleep(runId, delayDurationMs);
      expect(sleepAfterRecovery).toStrictEqual(sleepBeforeCrash);
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      expect(Date.now() - recoveredReadyAt).toBeLessThan(delayDurationMs);
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      try {
        await firstProcess.kill();
        await recoveredProcess?.kill();
      } finally {
        await records.close();
      }
    }
  }, 30_000);

  it('recovers after delay.cancelled append without duplicating the event', async () => {
    const runId = `delay-cancel-event-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'delay', undefined, {
      pauseAfterDelayCancelledEvent: true,
    });
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'delayWaiting' });
      firstProcess.cancel('operator');
      await firstProcess.waitFor({ kind: 'afterDelayCancelledEvent' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'delay');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'cancelled' });
      await recoveredProcess.waitFor({ kind: 'events' });
      expect(recoveredProcess.eventStream().types).toStrictEqual([
        'runCommand.accepted',
        'delay.cancelled',
      ]);
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);

  it.each([
    {
      name: 'accepted cancellation command decision',
      checkpoint: { kind: 'afterAcceptedCommand' },
      options: { pauseAfterAcceptedCommand: true },
    },
    {
      name: 'persisted cancellation directive',
      checkpoint: { kind: 'afterCancelDirective' },
      options: { pauseAfterCancelDirective: true },
    },
  ] satisfies readonly {
    readonly name: string;
    readonly checkpoint: Partial<RecoveryWorkerMessage>;
    readonly options: RecoveryProcessOptions;
  }[])(
    'recovers delay cancellation after $name',
    async ({ checkpoint, options }) => {
      const runId = `delay-cancel-checkpoint-recovery-${randomUUID()}`;
      const firstProcess = new RecoveryProcess('start', runId, 'delay', undefined, options);
      let recoveredProcess: RecoveryProcess | undefined;

      try {
        await firstProcess.waitFor({ kind: 'delayWaiting' });
        firstProcess.cancel('operator');
        await firstProcess.waitFor(checkpoint);
        await firstProcess.kill();

        recoveredProcess = new RecoveryProcess('recover', runId, 'delay');
        await recoveredProcess.waitFor({ kind: 'terminal', status: 'cancelled' });
        await recoveredProcess.waitFor({ kind: 'events' });
        expect(recoveredProcess.eventStream().types).toStrictEqual([
          'runCommand.accepted',
          'delay.cancelled',
        ]);
        await recoveredProcess.waitFor({ kind: 'stopped' });
      } finally {
        await firstProcess.kill();
        await recoveredProcess?.kill();
      }
    },
    30_000,
  );

  it('recovers parallel branches without repeating a checkpointed effect', async () => {
    const runId = `parallel-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'parallel');
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/work/a' });
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/work/b' });
      firstProcess.complete('main/work/a');
      await firstProcess.waitFor({ kind: 'checkpointed', path: 'main/work/a' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'parallel');
      await recoveredProcess.waitFor({
        kind: 'dispatched',
        path: 'main/work/b',
        attemptOrdinal: 2,
      });
      expect(recoveredProcess.dispatched('main/work/a')).toBe(0);

      recoveredProcess.complete('main/work/b');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);

  it('recovers between repeat iterations without replaying the completed iteration', async () => {
    const runId = `repeat-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'repeat', undefined, {
      pauseBeforeAdmission: 2,
    });
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({
        kind: 'dispatched',
        path: 'main/loop[1]/work',
        attemptOrdinal: 1,
      });
      firstProcess.complete('main/loop[1]/work', { outcome: 'retry' });
      await firstProcess.waitFor({
        kind: 'attemptObserved',
        path: 'main/loop[1]/work',
        status: 'completed',
      });
      await firstProcess.waitFor({ kind: 'beforeAdmission' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'repeat');
      await recoveredProcess.waitFor({
        kind: 'dispatched',
        path: 'main/loop[2]/work',
        attemptOrdinal: 1,
      });
      expect(recoveredProcess.dispatched('main/loop[1]/work')).toBe(0);

      recoveredProcess.complete('main/loop[2]/work');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'details' });
      expect(recoveredProcess.reportedDetails().nodeStatuses).toEqual([
        { path: 'main/loop[1]/work', status: 'completed' },
        { path: 'main/loop[2]/work', status: 'completed' },
      ]);
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);
});
