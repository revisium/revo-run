import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<unknown>>(),
  recv: vi.fn<(topic: string, options?: unknown) => Promise<unknown>>(),
  runStep: vi.fn<(callback: () => unknown, options?: unknown) => Promise<unknown>>(),
  send: vi.fn<(workflowId: string, message: unknown, topic: string) => Promise<void>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import type { RunEventDraft } from '../../src/contracts/run/run-event.js';
import { RunWorkflowV2Coordinator } from '../../src/dbos/coordination/run-workflow-v2-coordinator.js';
import { ScopeCancellationRegistry } from '../../src/dbos/coordination/scope-cancellation-registry.js';
import {
  commandReplyV2Topic,
  runCoordinatorReplyTopic,
  scopeDirectiveV2Topic,
  scopeReplyV2Topic,
  scopeSettlementV2Topic,
  unknownResolutionV2Topic,
} from '../../src/dbos/dbos-names.js';
import { RunEventBudgetExceededError } from '../../src/dbos/streams/run-event-stream.js';
import { commandWorkflowId } from '../../src/dbos/workflow-id.js';
import type { RunExecutorRequest } from '../../src/index.js';
import { createAttemptId } from '../../src/pipeline/identity/execution-identity.js';

const digest = (character: string): string => character.repeat(43);
const rootWorkflowId = `rr:scope:v2:sc1_${digest('a')}`;
const childWorkflowId = `rr:scope:v2:sc1_${digest('b')}`;
const secondChildWorkflowId = `rr:scope:v2:sc1_${digest('c')}`;
const commandId = 'cmd_00000000-0000-4000-8000-000000000001';
const secondCommandId = 'cmd_00000000-0000-4000-8000-000000000002';
const nodeInstanceId = `ni1_${digest('d')}`;
const request: RunExecutorRequest = {
  runId: 'run-1',
  scopeId: `sc1_${digest('e')}`,
  authoredNodeId: `an1_${digest('f')}`,
  nodeInstanceId,
  attemptId: `at1_${digest('g')}`,
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
const recovery = {
  reconciliation: 'required',
  maximumAttempts: 2,
  timeoutMs: 1_000,
  unknownOutcome: 'requireHumanResolution',
} as const;
const retry = {
  maximumAttempts: 2,
  backoff: { kind: 'constant', delayMs: 1 },
  retryableErrorCodes: ['retryable'],
} as const;

const isDirective = (value: unknown, kind: 'cancel' | 'fail' | 'settled'): boolean =>
  value !== null && typeof value === 'object' && 'kind' in value && value.kind === kind;

const unknownWaiting = (workflowId = rootWorkflowId, value = request) => ({
  kind: 'unknownOutcomeWaiting' as const,
  workflowId,
  request: value,
  attemptOrdinal: value.attemptOrdinal,
  reconciliationRound: 1,
  recovery,
  retry,
});

const resolutionCommand = (id: string, kind: 'adoptSuccess' | 'markFailed' | 'retry') => ({
  commandId: id,
  command: {
    kind: 'resolveUnknownOutcome' as const,
    input: {
      runId: 'run-1',
      attemptId: request.attemptId,
      actorId: 'operator',
      resolution:
        kind === 'adoptSuccess' ? ({ kind, outcome: 'completed' } as const) : ({ kind } as const),
    },
  },
});

const cancelCommand = (id = commandId) => ({
  commandId: id,
  command: { kind: 'cancelRun' as const, input: { runId: 'run-1', actorId: 'operator' } },
});

const runCoordinator = async (
  messages: readonly unknown[],
  maximumExecutions = 10,
  append = vi.fn<(event: RunEventDraft) => Promise<void>>(async () => undefined),
) => {
  const queue = [...messages];
  dbos.recv.mockImplementation(async () => queue.shift() ?? null);
  const cancellation = new ScopeCancellationRegistry();
  const cancel = vi.spyOn(cancellation, 'cancelRun');
  const coordinator = new RunWorkflowV2Coordinator(
    'run-1',
    { append },
    maximumExecutions,
    cancellation,
  );
  coordinator.registerRootScope(rootWorkflowId);
  const result = await coordinator.execute({
    workflowID: rootWorkflowId,
    getResult: async () => ({ status: 'failed', outcome: 'scope-result' }),
  });
  return { append, cancel, result };
};

describe('RR-07 root coordinator authority', () => {
  beforeEach(() => {
    dbos.recv.mockReset();
    dbos.send.mockReset().mockResolvedValue(undefined);
    dbos.runStep.mockReset().mockImplementation(async (callback) => callback());
    dbos.getWorkflowStatus.mockReset();
  });

  it('replays one internal cancel decision without a second event or transition', async () => {
    const messages = [
      cancelCommand(),
      cancelCommand(),
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ];
    const { append, cancel, result } = await runCoordinator(messages);

    expect(result).toEqual({ status: 'cancelled', outcome: 'cancelled' });
    expect(append).toHaveBeenCalledOnce();
    expect(dbos.runStep).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    const rootDirectiveCall = dbos.send.mock.calls.findIndex(
      ([workflowId, directive, topic]) =>
        workflowId === rootWorkflowId &&
        topic === scopeDirectiveV2Topic &&
        isDirective(directive, 'cancel'),
    );
    expect(dbos.send.mock.invocationCallOrder[rootDirectiveCall]).toBeLessThan(
      cancel.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const settlementAcknowledgementCall = dbos.send.mock.calls.findIndex(
      ([workflowId, acknowledgement, topic]) =>
        workflowId === rootWorkflowId &&
        topic === scopeSettlementV2Topic &&
        isDirective(acknowledgement, 'settled'),
    );
    expect(rootDirectiveCall).toBeGreaterThanOrEqual(0);
    expect(settlementAcknowledgementCall).toBeGreaterThan(rootDirectiveCall);
    expect(dbos.send).toHaveBeenCalledWith(
      commandWorkflowId(commandId),
      { status: 'receipt', receipt: { status: 'accepted', commandId } },
      commandReplyV2Topic,
    );
  });

  it('acknowledges settlement before excluding a later queued cancellation', async () => {
    const messages = [{ kind: 'scopeSettled', workflowId: rootWorkflowId }, cancelCommand()];
    const { append, cancel, result } = await runCoordinator(messages);

    expect(result).toEqual({ status: 'failed', outcome: 'scope-result' });
    expect(append).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(dbos.send).toHaveBeenCalledWith(
      rootWorkflowId,
      { kind: 'settled' },
      scopeSettlementV2Topic,
    );
    expect(dbos.send).not.toHaveBeenCalledWith(
      rootWorkflowId,
      { kind: 'cancel' },
      scopeDirectiveV2Topic,
    );
  });

  it('lets root finish linearize before cancel and rejects the later command as terminal', async () => {
    const messages = [
      { kind: 'scopeFinish', workflowId: rootWorkflowId },
      cancelCommand(),
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ];
    const { append, cancel, result } = await runCoordinator(messages);

    expect(result).toEqual({ status: 'failed', outcome: 'scope-result' });
    expect(cancel).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(dbos.runStep).not.toHaveBeenCalled();
    expect(dbos.send).toHaveBeenCalledWith(
      commandWorkflowId(commandId),
      {
        status: 'receipt',
        receipt: { status: 'rejected', commandId, reason: 'run_already_terminal' },
      },
      commandReplyV2Topic,
    );
  });

  it('lets cancel linearize before root finish', async () => {
    const messages = [
      cancelCommand(),
      { kind: 'scopeFinish', workflowId: rootWorkflowId },
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ];
    const { append, cancel, result } = await runCoordinator(messages);

    expect(result).toEqual({ status: 'cancelled', outcome: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
    expect(dbos.send).toHaveBeenCalledWith(
      commandWorkflowId(commandId),
      { status: 'receipt', receipt: { status: 'accepted', commandId } },
      commandReplyV2Topic,
    );
  });

  it('keeps child finish nonterminal while avoiding a stranded asynchronous directive', async () => {
    const messages = [
      {
        kind: 'scopeRegistered',
        workflowId: childWorkflowId,
        parentWorkflowId: rootWorkflowId,
      },
      { kind: 'scopeFinish', workflowId: childWorkflowId },
      cancelCommand(),
      { kind: 'scopeSettled', workflowId: childWorkflowId },
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ];
    const { result } = await runCoordinator(messages);

    expect(result).toEqual({ status: 'cancelled', outcome: 'cancelled' });
    expect(dbos.send).toHaveBeenCalledWith(
      childWorkflowId,
      { kind: 'continue' },
      scopeReplyV2Topic,
    );
    expect(dbos.send).not.toHaveBeenCalledWith(
      childWorkflowId,
      { kind: 'cancel' },
      scopeDirectiveV2Topic,
    );
    expect(dbos.send).toHaveBeenCalledWith(
      rootWorkflowId,
      { kind: 'cancel' },
      scopeDirectiveV2Topic,
    );
  });

  it('allows one unknown resolution and rejects the competing decision', async () => {
    const messages = [
      unknownWaiting(),
      resolutionCommand(commandId, 'markFailed'),
      resolutionCommand(secondCommandId, 'adoptSuccess'),
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ];
    const { append, result } = await runCoordinator(messages);

    expect(result).toEqual({ status: 'failed', outcome: 'scope-result' });
    expect(append).toHaveBeenCalledTimes(2);
    expect(dbos.send).toHaveBeenCalledWith(
      rootWorkflowId,
      { kind: 'markFailed', commandId, errorCode: 'unknown_outcome_resolved_failed' },
      unknownResolutionV2Topic(request.attemptId),
    );
    expect(dbos.send).toHaveBeenCalledWith(
      commandWorkflowId(secondCommandId),
      {
        status: 'receipt',
        receipt: {
          status: 'rejected',
          commandId: secondCommandId,
          reason: 'unknown_outcome_already_resolved',
        },
      },
      commandReplyV2Topic,
    );
  });

  it('replays one budgeted retry grant and denies it to another attempt', async () => {
    const nextAttemptId = createAttemptId({ nodeInstanceId, attemptOrdinal: 2 });
    const otherAttemptId = createAttemptId({ nodeInstanceId, attemptOrdinal: 3 });
    const messages = [
      { kind: 'reserveExecution', attemptId: request.attemptId, replyWorkflowId: rootWorkflowId },
      unknownWaiting(),
      resolutionCommand(commandId, 'retry'),
      {
        kind: 'reserveExecution',
        attemptId: nextAttemptId,
        replyWorkflowId: rootWorkflowId,
        permitCommandId: commandId,
      },
      {
        kind: 'reserveExecution',
        attemptId: nextAttemptId,
        replyWorkflowId: rootWorkflowId,
        permitCommandId: commandId,
      },
      {
        kind: 'reserveExecution',
        attemptId: otherAttemptId,
        replyWorkflowId: rootWorkflowId,
        permitCommandId: commandId,
      },
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ];
    await runCoordinator(messages, 2);

    expect(dbos.send).toHaveBeenCalledWith(
      rootWorkflowId,
      { attemptId: nextAttemptId, granted: true },
      runCoordinatorReplyTopic,
    );
    expect(dbos.send).toHaveBeenCalledWith(
      rootWorkflowId,
      { attemptId: otherAttemptId, granted: false },
      runCoordinatorReplyTopic,
    );
  });

  it('rejects retry when the execution budget has no capacity', async () => {
    const messages = [
      { kind: 'reserveExecution', attemptId: request.attemptId, replyWorkflowId: rootWorkflowId },
      unknownWaiting(),
      resolutionCommand(commandId, 'retry'),
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ];
    await runCoordinator(messages, 1);

    expect(dbos.send).toHaveBeenCalledWith(
      commandWorkflowId(commandId),
      {
        status: 'receipt',
        receipt: {
          status: 'rejected',
          commandId,
          reason: 'unknown_outcome_retry_not_permitted',
        },
      },
      commandReplyV2Topic,
    );
  });

  it('cancels every simultaneous unknown wait and rejects later resolution by inbox order', async () => {
    const secondRequest = {
      ...request,
      scopeId: `sc1_${digest('h')}`,
      nodeInstanceId: `ni1_${digest('i')}`,
      attemptId: `at1_${digest('j')}`,
      displayPath: 'main/other',
      nodePath: 'other',
      binding: {
        ...request.binding,
        target: { pipelineId: 'main', nodePath: 'other' },
      },
    } as const;
    const messages = [
      {
        kind: 'scopeRegistered',
        workflowId: childWorkflowId,
        parentWorkflowId: rootWorkflowId,
      },
      {
        kind: 'scopeRegistered',
        workflowId: secondChildWorkflowId,
        parentWorkflowId: rootWorkflowId,
      },
      unknownWaiting(childWorkflowId),
      unknownWaiting(secondChildWorkflowId, secondRequest),
      cancelCommand(),
      resolutionCommand(secondCommandId, 'markFailed'),
      { kind: 'scopeSettled', workflowId: childWorkflowId },
      { kind: 'scopeSettled', workflowId: secondChildWorkflowId },
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ];
    await runCoordinator(messages);

    expect(dbos.send).toHaveBeenCalledWith(
      childWorkflowId,
      { kind: 'cancel' },
      unknownResolutionV2Topic(request.attemptId),
    );
    expect(dbos.send).toHaveBeenCalledWith(
      secondChildWorkflowId,
      { kind: 'cancel' },
      unknownResolutionV2Topic(secondRequest.attemptId),
    );
    expect(dbos.send).toHaveBeenCalledWith(
      commandWorkflowId(secondCommandId),
      {
        status: 'receipt',
        receipt: {
          status: 'rejected',
          commandId: secondCommandId,
          reason: 'run_cancellation_requested',
        },
      },
      commandReplyV2Topic,
    );
  });

  it('fences a late-ready child and fails command dispatch when event budget is exhausted', async () => {
    const event = {
      type: 'pipeline.branchDefaulted',
      data: {
        scopeId: request.scopeId,
        authoredNodeId: request.authoredNodeId,
        nodeInstanceId: request.nodeInstanceId,
      },
    } as const;
    const append = vi.fn<(event: RunEventDraft) => Promise<void>>(async () => {
      throw new RunEventBudgetExceededError('maximum_run_event_count_exceeded');
    });
    const messages = [
      {
        kind: 'scopeRegistered',
        workflowId: childWorkflowId,
        parentWorkflowId: rootWorkflowId,
      },
      { kind: 'event', workflowId: rootWorkflowId, event },
      { kind: 'scopeReady', workflowId: childWorkflowId, parentWorkflowId: rootWorkflowId },
      cancelCommand(),
      { kind: 'scopeSettled', workflowId: childWorkflowId },
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ];
    const { cancel, result } = await runCoordinator(messages, 10, append);

    expect(result).toEqual({ status: 'failed', outcome: 'maximum_run_event_count_exceeded' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('run-1');
    const rootDirectiveCall = dbos.send.mock.calls.findIndex(
      ([workflowId, directive, topic]) =>
        workflowId === rootWorkflowId &&
        topic === scopeDirectiveV2Topic &&
        isDirective(directive, 'fail'),
    );
    expect(dbos.send.mock.invocationCallOrder[rootDirectiveCall]).toBeLessThan(
      cancel.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(dbos.runStep).not.toHaveBeenCalled();
    expect(dbos.send).toHaveBeenCalledWith(childWorkflowId, { kind: 'fail' }, scopeReplyV2Topic);
    expect(dbos.send).not.toHaveBeenCalledWith(
      childWorkflowId,
      { kind: 'fail' },
      scopeDirectiveV2Topic,
    );
    expect(dbos.send).toHaveBeenCalledWith(
      commandWorkflowId(commandId),
      { status: 'dispatchFailed', commandId },
      commandReplyV2Topic,
    );
  });
});
