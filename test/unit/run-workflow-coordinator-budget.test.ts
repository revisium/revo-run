import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  recv: vi.fn<(topic: string, options?: unknown) => Promise<unknown>>(),
  send: vi.fn<(workflowId: string, message: unknown, topic: string) => Promise<void>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { RunWorkflowCoordinator } from '../../src/dbos/coordination/run-workflow-coordinator.js';
import { runCoordinatorReplyTopic } from '../../src/dbos/dbos-names.js';
import { DbosRunEventStream } from '../../src/dbos/streams/run-event-stream.js';

const digest = (character: string): string => character.repeat(43);
const firstScope = `rr:scope:v2:sc1_${digest('a')}`;
const secondScope = `rr:scope:v2:sc1_${digest('b')}`;
const firstAttempt = `at1_${digest('c')}`;
const secondAttempt = `at1_${digest('d')}`;

describe('run workflow coordinator execution budget', () => {
  beforeEach(() => {
    dbos.recv.mockReset();
    dbos.send.mockReset().mockResolvedValue(undefined);
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
    const coordinator = new RunWorkflowCoordinator(new DbosRunEventStream(), 1);

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
});
