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
import { RunWorkflowCoordinator } from '../../src/dbos/coordination/run-workflow-coordinator.js';
import { ScopeCancellationRegistry } from '../../src/dbos/coordination/scope-cancellation-registry.js';
import { scopeReplyTopic } from '../../src/dbos/dbos-names.js';
import { ProviderCallRegistry } from '../../src/dbos/executor/provider-call-registry.js';
import { RunEventBudgetExceededError } from '../../src/dbos/streams/run-event-stream.js';
import { createSubpipelineScopeId } from '../../src/pipeline/identity/execution-identity.js';

const digest = (character: string): string => character.repeat(43);
const scopeId = `sc1_${digest('a')}`;
const rootWorkflowId = `rr:scope:${scopeId}`;
const nodeIdentity = {
  scopeId,
  authoredNodeId: `an1_${digest('b')}`,
  nodeInstanceId: `ni1_${digest('c')}`,
} as const;
const delayCancelled = {
  kind: 'event' as const,
  workflowId: rootWorkflowId,
  event: { type: 'delay.cancelled' as const, data: nodeIdentity },
};
const inlineScopeId = createSubpipelineScopeId({
  parentScopeId: scopeId,
  authoredNodeId: nodeIdentity.authoredNodeId,
  invocationOrdinal: 1,
});
const inlineOwnership = {
  kind: 'inlineScopeOwnership' as const,
  workflowId: rootWorkflowId,
  parentScopeId: scopeId,
  scopeId: inlineScopeId,
  authoredNodeId: nodeIdentity.authoredNodeId,
  invocationOrdinal: 1,
};
const inlineDelayCancelled = {
  ...delayCancelled,
  event: {
    ...delayCancelled.event,
    data: { ...nodeIdentity, scopeId: inlineScopeId },
  },
};
const cancelCommand = {
  commandId: 'cmd_00000000-0000-4000-8000-000000000001',
  command: {
    kind: 'cancelRun' as const,
    input: { runId: 'run-1', actorId: 'operator' },
  },
};

const runCoordinator = async (
  messages: readonly unknown[],
  append = vi.fn<(event: RunEventDraft) => Promise<void>>(async () => undefined),
) => {
  const queue = [...messages];
  dbos.recv.mockImplementation(async () => queue.shift() ?? null);
  const coordinator = new RunWorkflowCoordinator(
    'run-1',
    { append },
    10,
    new ScopeCancellationRegistry(),
    new ProviderCallRegistry(),
  );
  coordinator.registerRootScope(rootWorkflowId);
  const result = await coordinator.execute({
    workflowID: rootWorkflowId,
    getResult: async () => ({ status: 'cancelled', outcome: 'cancelled' }),
  });
  return { append, result };
};

describe('RR-09 delay cancellation event authority', () => {
  beforeEach(() => {
    dbos.recv.mockReset();
    dbos.send.mockReset().mockResolvedValue(undefined);
    dbos.runStep.mockReset().mockImplementation(async (callback) => callback());
    dbos.getWorkflowStatus.mockReset();
  });

  it('appends delay.cancelled once after the accepted cancellation command', async () => {
    const { append, result } = await runCoordinator([
      cancelCommand,
      delayCancelled,
      delayCancelled,
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ]);

    expect(result).toEqual({ status: 'cancelled', outcome: 'cancelled' });
    expect(append.mock.calls.map(([event]) => event.type)).toEqual([
      'runCommand.accepted',
      'delay.cancelled',
    ]);
  });

  it('accepts a late inline delay event only from its registered physical owner', async () => {
    const { append } = await runCoordinator([
      inlineOwnership,
      inlineOwnership,
      cancelCommand,
      inlineDelayCancelled,
      inlineDelayCancelled,
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ]);

    expect(append.mock.calls.map(([event]) => event.type)).toEqual([
      'runCommand.accepted',
      'delay.cancelled',
    ]);
  });

  it('returns the cancellation fence after a late ownership registration', async () => {
    await runCoordinator([
      cancelCommand,
      inlineOwnership,
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ]);

    expect(dbos.send).toHaveBeenCalledWith(rootWorkflowId, { kind: 'cancel' }, scopeReplyTopic);
  });

  it('returns the failure fence after ownership registration without changing precedence', async () => {
    const append = vi.fn<(event: RunEventDraft) => Promise<void>>(async () => {
      throw new RunEventBudgetExceededError('maximum_run_event_count_exceeded');
    });
    await runCoordinator(
      [delayCancelled, inlineOwnership, { kind: 'scopeSettled', workflowId: rootWorkflowId }],
      append,
    );

    expect(dbos.send).toHaveBeenCalledWith(rootWorkflowId, { kind: 'fail' }, scopeReplyTopic);
    expect(dbos.send).not.toHaveBeenCalledWith(rootWorkflowId, { kind: 'cancel' }, scopeReplyTopic);
  });

  it.each([
    {
      name: 'all other late events',
      message: {
        kind: 'event',
        workflowId: rootWorkflowId,
        event: { type: 'repeat.exhausted', data: nodeIdentity },
      },
    },
    {
      name: 'a mismatched sender scope',
      message: {
        ...delayCancelled,
        event: {
          ...delayCancelled.event,
          data: { ...nodeIdentity, scopeId: `sc1_${digest('d')}` },
        },
      },
    },
  ])('rejects $name after the cancellation fence', async ({ message }) => {
    const { append } = await runCoordinator([
      cancelCommand,
      message,
      { kind: 'scopeSettled', workflowId: rootWorkflowId },
    ]);

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: 'runCommand.accepted' }));
  });

  it('lets the normal event budget failure win over the late-event exception', async () => {
    const append = vi
      .fn<(event: RunEventDraft) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new RunEventBudgetExceededError('maximum_run_event_count_exceeded'));
    const { result } = await runCoordinator(
      [
        cancelCommand,
        delayCancelled,
        delayCancelled,
        { kind: 'scopeSettled', workflowId: rootWorkflowId },
      ],
      append,
    );

    expect(result).toEqual({
      status: 'failed',
      outcome: 'maximum_run_event_count_exceeded',
    });
    expect(append).toHaveBeenCalledTimes(2);
  });
});
