import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  workflowID: `rr:scope:sc1_${'a'.repeat(43)}`,
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<unknown>>(),
  recv: vi.fn<(topic: string, options?: unknown) => Promise<unknown>>(),
  send: vi.fn<(workflowId: string, message: unknown, topic: string) => Promise<void>>(),
  runStep: vi.fn<(callback: () => unknown, options?: unknown) => Promise<unknown>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import {
  RunCoordinatorClient,
  ScopeCancellationError,
} from '../../src/dbos/coordination/run-coordinator-client.js';
import { runCoordinatorTopic, scopeReplyTopic } from '../../src/dbos/dbos-names.js';
import { humanGateResolutionTopic } from '../../src/dbos/human-gate-names.js';

const gateInstanceId = `ni1_${'A'.repeat(43)}`;

const waitingRequest = {
  gateInstanceId,
  scopeId: `sc1_${'A'.repeat(43)}`,
  authoredNodeId: `an1_${'A'.repeat(43)}`,
  answers: ['approved'],
  decision: { kind: 'firstAnswer' as const },
  timeoutMs: 2_000,
};

describe('deadline park liveness', () => {
  beforeEach(() => {
    dbos.workflowID = `rr:scope:sc1_${'a'.repeat(43)}`;
    dbos.getWorkflowStatus.mockReset();
    dbos.recv.mockReset();
    dbos.send.mockReset().mockResolvedValue(undefined);
    dbos.runStep.mockReset().mockImplementation(async (callback) => callback());
  });

  it('stops a deadline park when the root coordinator is no longer active', async () => {
    dbos.recv
      .mockResolvedValueOnce({ kind: 'continue' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    dbos.getWorkflowStatus.mockResolvedValueOnce({ status: 'CANCELLED' });

    await expect(
      new RunCoordinatorClient('run-1').waitForHumanGate(waitingRequest),
    ).rejects.toBeInstanceOf(ScopeCancellationError);
    expect(dbos.recv.mock.calls[2]).toEqual([
      humanGateResolutionTopic(gateInstanceId),
      { timeoutSeconds: 2 },
    ]);
    expect(dbos.send).not.toHaveBeenCalledWith(
      'rr:run:run-1',
      expect.objectContaining({ kind: 'humanGateDeadlineReached' }),
      runCoordinatorTopic,
    );
  });

  it('still proposes a deadline while the root coordinator is live', async () => {
    dbos.recv
      .mockResolvedValueOnce({ kind: 'continue' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: 'timedOut' });
    dbos.getWorkflowStatus.mockResolvedValueOnce({ status: 'PENDING' });

    await expect(
      new RunCoordinatorClient('run-1').waitForHumanGate(waitingRequest),
    ).resolves.toEqual({
      kind: 'timedOut',
    });
    expect(dbos.send).toHaveBeenCalledWith(
      'rr:run:run-1',
      expect.objectContaining({
        kind: 'humanGateDeadlineReached',
        workflowId: dbos.workflowID,
        gateInstanceId,
      }),
      runCoordinatorTopic,
    );
    expect(dbos.recv.mock.calls[0]?.[0]).toBe(scopeReplyTopic);
  });
});
