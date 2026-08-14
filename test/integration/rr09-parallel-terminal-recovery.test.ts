import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RecoveryProcess } from '../support/process/recovery-process.js';

describe.sequential('RR-09 parallel terminal recovery', () => {
  it('recovers after a terminal branch result is durable and before its parent consumes it', async () => {
    const runId = `parallel-terminal-recovery-${randomUUID()}`;
    const firstProcess = new RecoveryProcess('start', runId, 'parallel-terminal', undefined, {
      pauseAfterTerminalBranchResult: true,
    });
    let recoveredProcess: RecoveryProcess | undefined;

    try {
      await firstProcess.waitFor({
        kind: 'dispatched',
        path: 'main/review/inner[1]/invalid',
      });
      await firstProcess.waitFor({ kind: 'dispatched', path: 'main/review/pending' });
      firstProcess.complete('main/review/inner[1]/invalid', { outcome: 'unexpected' });
      await firstProcess.waitFor({ kind: 'afterTerminalBranchResult' });
      await firstProcess.kill();

      recoveredProcess = new RecoveryProcess('recover', runId, 'parallel-terminal');
      await recoveredProcess.waitFor({ kind: 'terminal', status: 'failed' });
      expect(recoveredProcess.dispatched('main/review/inner[1]/invalid')).toBe(0);

      await recoveredProcess.waitFor({ kind: 'events' });
      expect(
        recoveredProcess.reportedEvents().filter(({ type }) => type === 'pipeline.invalidState'),
      ).toHaveLength(1);
      await recoveredProcess.waitFor({ kind: 'stopped' });
    } finally {
      await firstProcess.kill();
      await recoveredProcess?.kill();
    }
  }, 30_000);
});
