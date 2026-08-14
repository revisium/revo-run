import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RecoveryProcess } from '../support/process/recovery-process.js';

describe('RR-09 inline scope ownership recovery', () => {
  it('replays ownership registration before cancelling the recovered inline delay', async () => {
    const runId = `inline-ownership-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'inline-delay', undefined, {
      pauseAfterInlineOwnership: true,
    });
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({ kind: 'afterInlineOwnership' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'inline-delay');
      await recoveredProcess.waitFor({ kind: 'dispatched', path: 'main/phase/ready' });
      expect(recoveredProcess.dispatched('main/phase/ready')).toBe(1);
      recoveredProcess.complete('main/phase/ready');
      await recoveredProcess.waitFor({ kind: 'delayWaiting' });
      recoveredProcess.cancel('operator');

      await recoveredProcess.waitFor({ kind: 'terminal', status: 'cancelled' });
      await recoveredProcess.waitFor({ kind: 'events' });
      const events = recoveredProcess.eventStream();
      expect(events.types).toStrictEqual([
        'nodeExecution.started',
        'nodeExecution.completed',
        'runCommand.accepted',
        'delay.cancelled',
      ]);
      expect(events.cursors).toStrictEqual(
        events.cursors.map((_, index) => `${runId}:${index + 1}`),
      );
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);
});
