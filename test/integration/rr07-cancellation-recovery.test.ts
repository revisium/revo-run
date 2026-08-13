import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RecoveryProcess } from '../support/process/recovery-process.js';

describe('RR-07 cancellation recovery', () => {
  it('accepts cancellation before the root scope readiness handshake', async () => {
    const runId = `cancel-before-ready-${randomUUID()}`;
    const process = new RecoveryProcess('start', runId, 'sequence', undefined, {
      pauseBeforeReadiness: true,
    });

    try {
      await process.waitFor({ kind: 'beforeReadiness' });
      await process.waitFor({ kind: 'ready' });
      process.cancel('operator-before-ready');
      const receipt = await process.waitFor({ kind: 'commandReceipt' });
      expect(receipt.commandReceipt).toMatchObject({ status: 'accepted' });
      expect(process.dispatched('main/first')).toBe(0);

      process.releaseReadiness();
      await process.waitFor({ kind: 'terminal', status: 'cancelled' });
      await process.waitFor({ kind: 'events' });
      expect(process.eventStream().types).toStrictEqual(['runCommand.accepted']);
      await process.waitFor({ kind: 'stopped' });
    } finally {
      process.releaseReadiness();
      await process.kill();
    }
  }, 30_000);

  it('recovers child scopes, accepts cancellation, aborts providers, and settles the run', async () => {
    const runId = `cancel-after-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'parallel');
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/work/a' });
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/work/b' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'parallel');
      await recoveredProcess.waitFor({
        kind: 'dispatched',
        path: 'main/work/a',
        attemptOrdinal: 2,
      });
      await recoveredProcess.waitFor({
        kind: 'dispatched',
        path: 'main/work/b',
        attemptOrdinal: 2,
      });

      recoveredProcess.cancel('operator-after-recovery');
      const receipt = await recoveredProcess.waitFor({ kind: 'commandReceipt' });
      expect(receipt.commandReceipt).toMatchObject({ status: 'accepted' });
      await recoveredProcess.waitFor({ kind: 'executorAborted', path: 'main/work/a' });
      await recoveredProcess.waitFor({ kind: 'executorAborted', path: 'main/work/b' });
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'cancelled' });
      await recoveredProcess.waitFor({ kind: 'events' });
      expect(
        recoveredProcess.eventStream().types.filter((type) => type === 'runCommand.accepted'),
      ).toHaveLength(1);
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);

  it('recovers an accepted cancel before reconciling an interrupted provider', async () => {
    const runId = `cancel-accepted-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'sequence', undefined, {
      ignoreAbort: true,
    });
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/first' });
      firstProcess.cancel('operator-before-crash');
      const receipt = await firstProcess.waitFor({ kind: 'commandReceipt' });
      expect(receipt.commandReceipt).toMatchObject({ status: 'accepted' });
      await firstProcess.waitFor({ kind: 'executorAborted', path: 'main/first' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'sequence');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'cancelled' });
      expect(recoveredProcess.count('reconciled', 'main/first')).toBe(0);
      expect(recoveredProcess.dispatched('main/first')).toBe(0);
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);
});
