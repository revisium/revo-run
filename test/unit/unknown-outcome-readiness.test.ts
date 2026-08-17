import { beforeEach, describe, expect, it, vi } from 'vitest';

const digest = (character: string): string => character.repeat(43);
const attemptId = `at1_${digest('b')}`;

const dbos = vi.hoisted(() => ({
  workflowID: `rr:scope:sc1_${'a'.repeat(43)}`,
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<unknown>>(),
  recv: vi.fn<(topic: string, options?: unknown) => Promise<unknown>>(),
  runStep: vi.fn<(callback: () => unknown, options?: unknown) => Promise<unknown>>(),
  send: vi.fn<(workflowId: string, message: unknown, topic: string) => Promise<void>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import type { RunExecutorRequest } from '../../src/contracts/executor/run-executor.js';
import { orphanHealthCheckSeconds } from '../../src/dbos/coordination/orphan-health-check.js';
import {
  RunCoordinatorClient,
  ScopeCancellationError,
} from '../../src/dbos/coordination/run-coordinator-client.js';
import {
  runCoordinatorTopic,
  scopeDirectiveTopic,
  scopeReplyTopic,
  scopeSettlementTopic,
  unknownOutcomeReadyStepName,
  unknownOutcomeResolutionStepName,
  unknownResolutionTopic,
} from '../../src/dbos/dbos-names.js';
import { runWorkflowId } from '../../src/dbos/workflow-id.js';

const request: RunExecutorRequest = {
  runId: 'run-1',
  scopeId: `sc1_${digest('a')}`,
  authoredNodeId: `an1_${digest('c')}`,
  nodeInstanceId: `ni1_${digest('d')}`,
  attemptId,
  attemptOrdinal: 1,
  displayPath: 'main/work',
  pipelineId: 'main',
  nodePath: 'work',
  binding: {
    kind: 'script',
    target: { pipelineId: 'main', nodePath: 'work' },
    script: { id: 'effect.run', revision: 1 },
  },
  input: {},
};

describe('unknown-outcome readiness barrier', () => {
  beforeEach(() => {
    dbos.getWorkflowStatus.mockReset();
    dbos.recv.mockReset();
    dbos.runStep.mockReset().mockImplementation(async (callback) => callback());
    dbos.send.mockReset().mockResolvedValue(undefined);
  });

  it('wakes immediately on a controlled cancellation without an orphan-health timeout cycle', async () => {
    dbos.recv.mockImplementation(async (topic) =>
      topic === scopeReplyTopic ? { kind: 'continue' } : { kind: 'cancel' },
    );
    const client = new RunCoordinatorClient(request.runId);

    await expect(client.ready(runWorkflowId(request.runId))).rejects.toBeInstanceOf(
      ScopeCancellationError,
    );

    expect(dbos.recv.mock.calls).toStrictEqual([
      [scopeReplyTopic, { timeoutSeconds: orphanHealthCheckSeconds }],
      [scopeDirectiveTopic, { timeoutSeconds: 0 }],
    ]);
    expect(dbos.getWorkflowStatus).not.toHaveBeenCalled();
  });

  it('keeps retry directives separate from the next correlated boundary reply', async () => {
    dbos.recv
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: 'continue' })
      .mockResolvedValueOnce(null);
    const client = new RunCoordinatorClient(request.runId);

    await expect(client.waitForRetry(request, 5_000)).resolves.toBeUndefined();

    expect(dbos.recv.mock.calls).toStrictEqual([
      [scopeDirectiveTopic, { timeoutSeconds: 5 }],
      [scopeReplyTopic, { timeoutSeconds: orphanHealthCheckSeconds }],
      [scopeDirectiveTopic, { timeoutSeconds: 0 }],
    ]);
    expect(dbos.send).toHaveBeenCalledWith(
      runWorkflowId(request.runId),
      expect.objectContaining({ kind: 'scopeBoundary' }),
      runCoordinatorTopic,
    );
  });

  it('drains an unsolicited directive after consuming the finish acknowledgement', async () => {
    dbos.recv.mockResolvedValueOnce({ kind: 'continue' }).mockResolvedValueOnce({ kind: 'cancel' });
    const client = new RunCoordinatorClient(request.runId);

    await expect(client.finish()).rejects.toBeInstanceOf(ScopeCancellationError);

    expect(dbos.recv.mock.calls).toStrictEqual([
      [scopeReplyTopic, { timeoutSeconds: orphanHealthCheckSeconds }],
      [scopeDirectiveTopic, { timeoutSeconds: 0 }],
    ]);
    expect(dbos.send).toHaveBeenCalledWith(
      runWorkflowId(request.runId),
      expect.objectContaining({ kind: 'scopeFinish' }),
      runCoordinatorTopic,
    );
  });

  it('receives asynchronous cancellation during backoff without waiting for a reply', async () => {
    dbos.recv.mockResolvedValueOnce({ kind: 'cancel' });
    const client = new RunCoordinatorClient(request.runId);

    await expect(client.waitForRetry(request, 5_000)).rejects.toBeInstanceOf(
      ScopeCancellationError,
    );

    expect(dbos.recv).toHaveBeenCalledOnce();
    expect(dbos.recv).toHaveBeenCalledWith(scopeDirectiveTopic, {
      timeoutSeconds: 5,
    });
    expect(dbos.send).not.toHaveBeenCalled();
  });

  it('does not leave a normal readiness directive queued after its correlated reply', async () => {
    dbos.recv.mockResolvedValueOnce({ kind: 'continue' }).mockResolvedValueOnce(null);
    const client = new RunCoordinatorClient(request.runId);

    await expect(client.ready(runWorkflowId(request.runId))).resolves.toBeUndefined();

    expect(dbos.recv.mock.calls).toStrictEqual([
      [scopeReplyTopic, { timeoutSeconds: orphanHealthCheckSeconds }],
      [scopeDirectiveTopic, { timeoutSeconds: 0 }],
    ]);
    expect(dbos.getWorkflowStatus).not.toHaveBeenCalled();
  });

  it('wakes immediately on a reply-channel cancellation without an orphan-health timeout cycle', async () => {
    dbos.recv.mockResolvedValueOnce({ kind: 'cancel' }).mockResolvedValueOnce(null);
    const client = new RunCoordinatorClient(request.runId);

    await expect(client.ready(runWorkflowId(request.runId))).rejects.toBeInstanceOf(
      ScopeCancellationError,
    );

    expect(dbos.recv.mock.calls).toStrictEqual([
      [scopeReplyTopic, { timeoutSeconds: orphanHealthCheckSeconds }],
      [scopeDirectiveTopic, { timeoutSeconds: 0 }],
    ]);
    expect(dbos.getWorkflowStatus).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'fail'] as const)(
    'consumes a terminal %s directive without preventing scope settlement',
    async (kind) => {
      dbos.recv.mockResolvedValueOnce({ kind: 'settled' }).mockResolvedValueOnce({ kind });
      const client = new RunCoordinatorClient(request.runId);

      await expect(client.scopeSettled()).resolves.toBeUndefined();

      expect(dbos.recv.mock.calls).toStrictEqual([
        [scopeSettlementTopic, { timeoutSeconds: orphanHealthCheckSeconds }],
        [scopeDirectiveTopic, { timeoutSeconds: 0 }],
      ]);
      expect(dbos.send).toHaveBeenCalledWith(
        runWorkflowId(request.runId),
        { kind: 'scopeSettled', workflowId: dbos.workflowID },
        runCoordinatorTopic,
      );
      expect(dbos.send.mock.invocationCallOrder[0]).toBeLessThan(
        dbos.recv.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(dbos.recv.mock.invocationCallOrder[0]).toBeLessThan(
        dbos.recv.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
      );
    },
  );

  it('settles the scope before rejecting a malformed terminal directive', async () => {
    dbos.recv
      .mockResolvedValueOnce({ kind: 'settled' })
      .mockResolvedValueOnce({ kind: 'cancel', extra: true });
    const client = new RunCoordinatorClient(request.runId);

    await expect(client.scopeSettled()).rejects.toThrow('Scope directive is invalid.');

    expect(dbos.send).toHaveBeenCalledWith(
      runWorkflowId(request.runId),
      { kind: 'scopeSettled', workflowId: dbos.workflowID },
      runCoordinatorTopic,
    );
    expect(dbos.send.mock.invocationCallOrder[0]).toBeLessThan(
      dbos.recv.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('rejects a malformed settlement acknowledgement after publishing settlement', async () => {
    dbos.recv.mockResolvedValueOnce({ kind: 'settled', extra: true });
    const client = new RunCoordinatorClient(request.runId);

    await expect(client.scopeSettled()).rejects.toThrow(
      'Scope settlement acknowledgement is invalid.',
    );

    expect(dbos.send).toHaveBeenCalledWith(
      runWorkflowId(request.runId),
      { kind: 'scopeSettled', workflowId: dbos.workflowID },
      runCoordinatorTopic,
    );
    expect(dbos.recv).toHaveBeenCalledOnce();
  });

  it('publishes readiness only after the root acknowledges durable waiting registration', async () => {
    dbos.recv
      .mockResolvedValueOnce({ kind: 'continue' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        kind: 'markFailed',
        commandId: 'cmd_00000000-0000-4000-8000-000000000001',
        errorCode: 'unknown_outcome_resolved_failed',
      });
    const client = new RunCoordinatorClient(request.runId);

    await expect(
      client.waitForUnknownOutcome(
        request,
        {
          reconciliation: 'required',
          maximumAttempts: 2,
          timeoutMs: 1_000,
          unknownOutcome: 'requireHumanResolution',
        },
        undefined,
        1,
      ),
    ).resolves.toMatchObject({ kind: 'markFailed' });

    expect(dbos.send).toHaveBeenCalledWith(
      runWorkflowId(request.runId),
      expect.objectContaining({ kind: 'unknownOutcomeWaiting', request }),
      runCoordinatorTopic,
    );
    expect(dbos.recv).toHaveBeenNthCalledWith(1, scopeReplyTopic, {
      timeoutSeconds: orphanHealthCheckSeconds,
    });
    expect(dbos.runStep).toHaveBeenNthCalledWith(1, expect.any(Function), {
      name: unknownOutcomeReadyStepName(attemptId),
    });
    expect(dbos.recv).toHaveBeenNthCalledWith(2, scopeDirectiveTopic, {
      timeoutSeconds: 0,
    });
    expect(dbos.recv).toHaveBeenNthCalledWith(3, unknownResolutionTopic(attemptId), {
      timeoutSeconds: orphanHealthCheckSeconds,
    });
    expect(dbos.runStep).toHaveBeenNthCalledWith(2, expect.any(Function), {
      name: unknownOutcomeResolutionStepName(attemptId),
    });
    expect(dbos.recv.mock.invocationCallOrder[0]).toBeLessThan(
      dbos.runStep.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(dbos.runStep.mock.invocationCallOrder[0]).toBeLessThan(
      dbos.recv.mock.invocationCallOrder[2] ?? Number.POSITIVE_INFINITY,
    );
  });
});
