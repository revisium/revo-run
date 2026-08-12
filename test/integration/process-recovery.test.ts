import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { isNodeExecutionStepName } from '../../src/dbos/dbos-names.js';
import { RecoveryProcess } from '../support/process/recovery-process.js';
import { RetryBackoffRecords } from '../support/process/retry-backoff-records.js';

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
      await recoveredProcess.waitFor({ kind: 'dispatched', path: 'main/second' });
      expect(recoveredProcess.dispatched('main/first')).toBe(0);

      recoveredProcess.complete('main/second');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'events' });
      const events = recoveredProcess.eventStream();
      expect(events.types).toStrictEqual([
        'nodeExecution.started',
        'nodeExecution.completed',
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
      await recoveredProcess.waitFor({ kind: 'dispatched', path: 'main/after-timeout' });
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
      expect(
        operations.filter(
          ({ name, startedAtEpochMs, completedAtEpochMs }) =>
            name === 'DBOS.sleep' &&
            startedAtEpochMs !== undefined &&
            completedAtEpochMs !== undefined &&
            completedAtEpochMs > startedAtEpochMs,
        ),
      ).toStrictEqual([
        expect.objectContaining({
          functionID: sleepBeforeCrash.functionID,
          startedAtEpochMs: sleepBeforeCrash.startedAtEpochMs,
          completedAtEpochMs: sleepBeforeCrash.deadlineEpochMs,
        }),
      ]);
      expect(
        operations.filter(({ name }) => isNodeExecutionStepName(name)).map(({ name }) => name),
      ).toStrictEqual(['execute-node-attempt:1:main/work', 'execute-node-attempt:2:main/work']);
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
      await recoveredProcess.waitFor({ kind: 'dispatched', path: 'main/work/b' });
      expect(recoveredProcess.dispatched('main/work/a')).toBe(0);

      recoveredProcess.complete('main/work/b');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'succeeded' });
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);
});
