import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  workflowID: `rr:scope:sc1_${'a'.repeat(43)}`,
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<unknown>>(),
  recv: vi.fn<(topic: string, options?: unknown) => Promise<unknown>>(),
  send: vi.fn<(workflowId: string, message: unknown, topic: string) => Promise<void>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { RunCoordinatorClient } from '../../src/dbos/coordination/run-coordinator-client.js';
import {
  runCoordinatorTopic,
  scopeDirectiveTopic,
  scopeReplyTopic,
} from '../../src/dbos/dbos-names.js';

describe('RR-09 durable delay wait', () => {
  beforeEach(() => {
    dbos.workflowID = `rr:scope:sc1_${'a'.repeat(43)}`;
    dbos.getWorkflowStatus.mockReset();
    dbos.recv.mockReset();
    dbos.send.mockReset().mockResolvedValue(undefined);
  });

  it('uses interruptible durable recv and linearizes elapsed timeout through a boundary', async () => {
    dbos.recv
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: 'continue' })
      .mockResolvedValueOnce(null);

    await expect(new RunCoordinatorClient('run-1').waitForDelay(250)).resolves.toBe('elapsed');
    expect(dbos.recv.mock.calls[0]).toEqual([scopeDirectiveTopic, { timeoutSeconds: 0.25 }]);
    expect(dbos.send).toHaveBeenCalledWith(
      `rr:run:run-1`,
      expect.objectContaining({ kind: 'scopeBoundary', workflowId: dbos.workflowID }),
      runCoordinatorTopic,
    );
    expect(dbos.recv.mock.calls[1]?.[0]).toBe(scopeReplyTopic);
  });

  it.each([
    { directive: { kind: 'cancel' }, result: 'cancelled' },
    { directive: { kind: 'fail' }, result: 'failed' },
  ] as const)(
    'wakes promptly with $result from the directive topic',
    async ({ directive, result }) => {
      dbos.recv.mockResolvedValueOnce(directive);

      await expect(new RunCoordinatorClient('run-1').waitForDelay(60_000)).resolves.toBe(result);
      expect(dbos.recv).toHaveBeenCalledOnce();
      expect(dbos.send).not.toHaveBeenCalled();
    },
  );

  it('observes cancellation that wins immediately after timeout', async () => {
    dbos.recv
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: 'cancel' })
      .mockResolvedValueOnce(null);

    await expect(new RunCoordinatorClient('run-1').waitForDelay(250)).resolves.toBe('cancelled');
  });
});
