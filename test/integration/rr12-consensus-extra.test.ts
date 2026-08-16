import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunManager } from '../../src/index.js';
import { agentBinding, end, executionPlan, routeOutcomes, task } from '../dsl/pipeline-builder.js';
import { completeConsensusParticipant } from '../support/acceptance/complete-consensus-participant.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const twoParticipantPlan = (remaining: 'cancel' | 'drain') =>
  executionPlan(
    routeOutcomes(
      {
        kind: 'consensus',
        key: 'review',
        participants: { a: task('a'), b: task('b') },
        policy: { kind: 'threshold', approve: 1, reject: 2 },
        remaining,
      },
      { approved: end('succeeded'), rejected: end('failed') },
    ),
    {
      bindings: [agentBinding('review/a', 'reviewer'), agentBinding('review/b', 'reviewer')],
    },
  );

const waitForPendingConsensus = async (
  manager: ReturnType<typeof createRunManager>,
  runId: string,
) =>
  vi.waitFor(
    async () => {
      const details = await manager.getRunDetails(runId);
      const consensus = details?.consensuses.find((entry) => entry.status === 'pending');
      expect(consensus).toBeDefined();
      return consensus!;
    },
    { timeout: 10_000 },
  );

describe('RR-12 extra consensus coverage', () => {
  let manager: ReturnType<typeof createRunManager> | undefined;
  let runId = '';

  afterEach(async () => {
    if (manager !== undefined) {
      const run = await manager.getRun(runId);
      if (run !== undefined && run.status !== 'succeeded' && run.status !== 'failed') {
        await manager.cancelRun({ runId, actorId: 'teardown' }).catch(() => undefined);
      }
      await manager.stop().catch(() => undefined);
      manager = undefined;
    }
  });

  it('projects pending then resolved consensus from records and drains leftovers', async () => {
    const executor = new ControlledRunExecutor();
    manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
    await manager.start();
    runId = `rr12-drain-${randomUUID()}`;
    const plan = twoParticipantPlan('drain');
    await manager.startRun({ runId, executionPlan: plan, input: null });
    const pending = await waitForPendingConsensus(manager, runId);
    expect(pending.acceptedVotes).toEqual([]);
    expect(pending.remainingParticipantIds).toEqual(['a', 'b']);

    await completeConsensusParticipant(manager, executor, runId, plan, {
      nodePath: 'main/review',
      participantId: 'a',
      vote: 'approve',
      executionId: 'execution-a-1',
    });

    const resolved = await vi.waitFor(
      async () => {
        const details = await manager?.getRunDetails(runId);
        const consensus = details?.consensuses.find(
          (entry) => entry.nodeInstanceId === pending.nodeInstanceId,
        );
        expect(consensus?.status).toBe('resolved');
        return consensus;
      },
      { timeout: 10_000 },
    );
    expect(resolved).toMatchObject({
      status: 'resolved',
      verdict: 'approved',
      remainingParticipantIds: ['b'],
    });
    expect((await manager.getRun(runId))?.status).toBe('running');

    await executor.complete('main/review/b', {
      kind: 'completed',
      outcome: 'reject',
      output: {
        vote: {
          kind: 'json',
          value: {
            nodePath: 'main/review',
            participantId: 'b',
            vote: 'reject',
            executionId: 'execution-b-1',
          },
        },
      },
    });
    await vi.waitFor(
      async () => {
        expect((await manager?.getRun(runId))?.status).toBe('succeeded');
      },
      { timeout: 10_000 },
    );
    const afterDrain = await manager.getRunDetails(runId);
    expect(afterDrain?.consensuses[0]).toMatchObject({ status: 'resolved', verdict: 'approved' });
  });

  it('does not inject a known unresolved authored participant', async () => {
    const executor = new ControlledRunExecutor();
    manager = createRunManager({ database: { url: testDatabaseUrl() }, executor });
    await manager.start();
    runId = `rr12-harness-${randomUUID()}`;
    const plan = twoParticipantPlan('cancel');
    await manager.startRun({ runId, executionPlan: plan, input: null });
    await waitForPendingConsensus(manager, runId);
    await completeConsensusParticipant(manager, executor, runId, plan, {
      nodePath: 'main/review',
      participantId: 'a',
      vote: 'approve',
      executionId: 'execution-a-1',
    });
    expect(executor.executionCount('main/review/a')).toBe(1);
    await vi.waitFor(
      async () => {
        expect((await manager?.getRun(runId))?.status).toBe('succeeded');
      },
      { timeout: 10_000 },
    );
  });
});
