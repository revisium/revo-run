import { beforeEach, describe, expect, it, vi } from 'vitest';

const digest = (character: string): string => character.repeat(43);
const physicalScopeId = `sc1_${digest('a')}`;
const physicalWorkflowId = `rr:scope:${physicalScopeId}`;
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

import {
  RunCoordinatorClient,
  ScopeCancellationError,
} from '../../src/dbos/coordination/run-coordinator-client.js';
import {
  runCoordinatorTopic,
  scopeDirectiveTopic,
  scopeReplyTopic,
} from '../../src/dbos/dbos-names.js';
import { createSubpipelineScopeId } from '../../src/pipeline/identity/execution-identity.js';

const authoredNodeId = `an1_${digest('b')}`;
const scopeId = createSubpipelineScopeId({
  parentScopeId: physicalScopeId,
  authoredNodeId,
  invocationOrdinal: 1,
});
const registration = {
  parentScopeId: physicalScopeId,
  scopeId,
  authoredNodeId,
  invocationOrdinal: 1,
};

describe('RR-09 inline scope ownership client', () => {
  beforeEach(() => {
    dbos.recv.mockReset();
    dbos.send.mockReset().mockResolvedValue(undefined);
  });

  it('registers the logical scope under the current physical workflow identity', async () => {
    dbos.recv.mockImplementation(async (topic: string) =>
      topic === scopeReplyTopic ? { kind: 'continue' } : null,
    );

    await new RunCoordinatorClient('run-1').registerInlineScopeOwnership(registration);

    expect(dbos.send).toHaveBeenCalledWith(
      'rr:run:run-1',
      { kind: 'inlineScopeOwnership', workflowId: physicalWorkflowId, ...registration },
      runCoordinatorTopic,
    );
    expect(dbos.recv).toHaveBeenCalledWith(scopeDirectiveTopic, { timeoutSeconds: 0 });
  });

  it('surfaces a cancellation fence before inline traversal can continue', async () => {
    dbos.recv.mockImplementation(async (topic: string) =>
      topic === scopeReplyTopic ? { kind: 'cancel' } : null,
    );

    await expect(
      new RunCoordinatorClient('run-1').registerInlineScopeOwnership(registration),
    ).rejects.toBeInstanceOf(ScopeCancellationError);
  });
});
