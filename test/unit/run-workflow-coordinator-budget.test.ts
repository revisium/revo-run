import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  now: vi.fn<() => Promise<number>>(),
  recv: vi.fn<(topic: string, options?: unknown) => Promise<unknown>>(),
  send: vi.fn<(workflowId: string, message: unknown, topic: string) => Promise<void>>(),
  writeStream: vi.fn<(name: string, value: unknown) => Promise<void>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { RunWorkflowCoordinator } from '../../src/dbos/coordination/run-workflow-coordinator.js';
import { runCoordinatorReplyTopic } from '../../src/dbos/dbos-names.js';
import {
  DbosRunEventStream,
  RunEventBudgetExceededError,
} from '../../src/dbos/streams/run-event-stream.js';

const digest = (character: string): string => character.repeat(43);
const firstScope = `rr:scope:v2:sc1_${digest('a')}`;
const secondScope = `rr:scope:v2:sc1_${digest('b')}`;
const firstAttempt = `at1_${digest('c')}`;
const secondAttempt = `at1_${digest('d')}`;
const eventDraft = {
  type: 'pipeline.branchDefaulted',
  data: {
    scopeId: `sc1_${digest('e')}`,
    authoredNodeId: `an1_${digest('f')}`,
    nodeInstanceId: `ni1_${digest('g')}`,
  },
} as const;

describe('run workflow coordinator execution budget', () => {
  beforeEach(() => {
    dbos.now.mockReset().mockResolvedValue(Date.UTC(2026, 7, 10));
    dbos.recv.mockReset();
    dbos.send.mockReset().mockResolvedValue(undefined);
    dbos.writeStream.mockReset().mockResolvedValue(undefined);
  });

  it('grants up to the budget and deterministically denies the next reservation', async () => {
    dbos.recv
      .mockResolvedValueOnce({
        kind: 'reserveExecution',
        attemptId: firstAttempt,
        replyWorkflowId: firstScope,
      })
      .mockResolvedValueOnce({
        kind: 'reserveExecution',
        attemptId: secondAttempt,
        replyWorkflowId: secondScope,
      })
      .mockResolvedValueOnce({ kind: 'scopeSettled', workflowId: firstScope });
    const result = { status: 'succeeded', outcome: 'completed' } as const;
    const coordinator = new RunWorkflowCoordinator(new DbosRunEventStream('run-1'), 1);

    await expect(
      coordinator.execute({ workflowID: firstScope, getResult: async () => result }),
    ).resolves.toEqual(result);

    expect(dbos.send).toHaveBeenNthCalledWith(
      1,
      firstScope,
      { attemptId: firstAttempt, granted: true },
      runCoordinatorReplyTopic,
    );
    expect(dbos.send).toHaveBeenNthCalledWith(
      2,
      secondScope,
      { attemptId: secondAttempt, granted: false },
      runCoordinatorReplyTopic,
    );
  });

  it('waits for the root and every registered nested scope after an event budget failure', async () => {
    let settleNestedScope: ((message: unknown) => void) | undefined;
    const nestedSettlement = new Promise<unknown>((resolve) => {
      settleNestedScope = resolve;
    });
    dbos.recv
      .mockResolvedValueOnce({ kind: 'event', event: eventDraft })
      .mockResolvedValueOnce({ kind: 'scopeRegistered', workflowId: secondScope })
      .mockResolvedValueOnce({ kind: 'scopeSettled', workflowId: firstScope })
      .mockReturnValueOnce(nestedSettlement);
    dbos.writeStream.mockRejectedValueOnce(
      new RunEventBudgetExceededError('maximum_run_event_count_exceeded'),
    );
    const getResult = vi
      .fn<() => Promise<{ readonly status: 'succeeded'; readonly outcome: 'completed' }>>()
      .mockResolvedValue({ status: 'succeeded', outcome: 'completed' });
    const coordinator = new RunWorkflowCoordinator(new DbosRunEventStream('run-1'), 10);

    const result = coordinator.execute({ workflowID: firstScope, getResult });
    await vi.waitFor(() => expect(dbos.recv).toHaveBeenCalledTimes(4));
    expect(getResult).not.toHaveBeenCalled();

    settleNestedScope?.({ kind: 'scopeSettled', workflowId: secondScope });
    await expect(result).resolves.toStrictEqual({
      status: 'failed',
      outcome: 'maximum_run_event_count_exceeded',
    });
    expect(getResult).toHaveBeenCalledOnce();
  });

  it('denies reservations and rejects later events while preserving the first budget outcome', async () => {
    dbos.recv
      .mockResolvedValueOnce({ kind: 'event', event: eventDraft })
      .mockResolvedValueOnce({
        kind: 'reserveExecution',
        attemptId: secondAttempt,
        replyWorkflowId: secondScope,
      })
      .mockResolvedValueOnce({ kind: 'event', event: eventDraft })
      .mockResolvedValueOnce({ kind: 'scopeSettled', workflowId: firstScope });
    dbos.writeStream
      .mockRejectedValueOnce(new RunEventBudgetExceededError('maximum_run_event_count_exceeded'))
      .mockRejectedValueOnce(new RunEventBudgetExceededError('maximum_run_event_bytes_exceeded'));
    const coordinator = new RunWorkflowCoordinator(new DbosRunEventStream('run-1'), 10);

    await expect(
      coordinator.execute({
        workflowID: firstScope,
        getResult: async () => ({ status: 'succeeded', outcome: 'completed' }),
      }),
    ).resolves.toStrictEqual({
      status: 'failed',
      outcome: 'maximum_run_event_count_exceeded',
    });

    expect(dbos.writeStream).toHaveBeenCalledOnce();
    expect(dbos.now).toHaveBeenCalledOnce();
    expect(dbos.send).toHaveBeenCalledWith(
      secondScope,
      { attemptId: secondAttempt, granted: false },
      runCoordinatorReplyTopic,
    );
  });
});
