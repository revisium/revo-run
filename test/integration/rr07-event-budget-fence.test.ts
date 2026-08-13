import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RecoveryProcess } from '../support/process/recovery-process.js';

describe('RR-07 event-budget command fence', () => {
  it('fails dispatch, fences a late-ready child, and waits for every scope to settle', async () => {
    const runId = `event-budget-late-ready-${randomUUID()}`;
    const process = new RecoveryProcess('start', runId, 'parallel', undefined, {
      failCommandEventBudget: true,
      pauseBeforeReadiness: 2,
    });

    try {
      await process.waitFor({ kind: 'beforeReadiness' });
      await process.waitFor({ kind: 'ready' });
      await process.waitFor({ kind: 'dispatched', path: 'main/work/b' });
      process.cancel('budget-operator');
      await process.waitFor({ kind: 'error', message: 'Run command failed.' });
      expect(process.commandReceipts()).toStrictEqual([]);
      await process.waitFor({ kind: 'executorAborted', path: 'main/work/b' });

      process.releaseReadiness();
      await process.waitFor({ kind: 'terminal', status: 'failed' });
      expect(process.dispatched('main/work/a')).toBe(0);
      await process.waitFor({ kind: 'details' });
      expect(process.reportedDetails().commands).toStrictEqual([]);
      expect(process.reportedDetails().nodeStatuses).toStrictEqual([]);
      await process.waitFor({ kind: 'events' });
      expect(
        process
          .eventStream()
          .types.some((type) => type === 'runCommand.accepted' || type === 'runCommand.rejected'),
      ).toBe(false);
      await process.waitFor({ kind: 'stopped' });
    } finally {
      process.releaseReadiness();
      await process.kill();
    }
  }, 30_000);
});
