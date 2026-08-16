import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunManager } from '../../src/index.js';
import { end, executionPlan, routeOutcomes, sequence } from '../dsl/pipeline-builder.js';
import { ControlledRunExecutor } from '../support/executor/controlled-run-executor.js';
import { testDatabaseUrl } from '../support/test-environment.js';

const unknownGateInstanceId = `ni1_${'B'.repeat(43)}`;

const approvalPlan = () =>
  executionPlan(
    routeOutcomes(
      {
        kind: 'humanGate',
        key: 'approval',
        answers: ['approved', 'rejected'],
        decision: { kind: 'firstAnswer' },
      },
      {
        approved: sequence({ kind: 'delay', key: 'settle', durationMs: 2_000 }, end('succeeded')),
        rejected: end('failed'),
      },
    ),
  );

const cancelledSubtreePlan = () =>
  executionPlan(
    sequence(
      {
        kind: 'parallel',
        key: 'review',
        branches: {
          approval: {
            kind: 'humanGate',
            key: 'approval',
            answers: ['approved', 'rejected'],
            decision: { kind: 'firstAnswer' },
          },
          stop: end('failed'),
        },
        join: { kind: 'any', successfulOutcomes: ['failed'], remaining: 'cancel' },
      },
      { kind: 'delay', key: 'settle', durationMs: 2_000 },
      end('succeeded'),
    ),
  );

const waitForPendingGate = async (manager: ReturnType<typeof createRunManager>, runId: string) => {
  const deadline = Date.now() + 10_000;
  const poll = async (): Promise<
    NonNullable<Awaited<ReturnType<typeof manager.getRunDetails>>>['gates'][number]
  > => {
    const details = await manager.getRunDetails(runId);
    const gate = details?.gates.find((entry) => entry.status === 'pending');
    if (gate !== undefined) {
      return gate;
    }
    if (Date.now() >= deadline) {
      throw new Error('Pending human gate was not projected.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return poll();
  };
  return poll();
};

describe('RR-11 human gate details and receipts', () => {
  let manager: ReturnType<typeof createRunManager> | undefined;

  afterEach(async () => {
    if (manager !== undefined) {
      const run = await manager.getRun(managerRunId);
      if (run !== undefined && run.status !== 'succeeded' && run.status !== 'failed') {
        await manager
          .cancelRun({ runId: managerRunId, actorId: 'teardown' })
          .catch(() => undefined);
      }
      await manager.stop().catch(() => undefined);
      manager = undefined;
    }
  });

  let managerRunId = '';

  it('AC-09 projects pending then resolved gate state from durable records, including actorId', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: new ControlledRunExecutor(),
    });
    await manager.start();
    managerRunId = `rr11-ac09-${randomUUID()}`;
    await manager.startRun({
      runId: managerRunId,
      executionPlan: approvalPlan(),
      input: null,
    });
    const pending = await waitForPendingGate(manager, managerRunId);
    expect(pending.status).toBe('pending');
    expect(pending.answers).toEqual(['approved', 'rejected']);
    expect(pending.acceptedAnswers).toEqual([]);
    expect(pending.displayPath).toBe('main/approval');

    const commandId = `cmd_${randomUUID()}` as const;
    await expect(
      manager.answerGate({
        runId: managerRunId,
        gateInstanceId: pending.id,
        answer: 'approved',
        actorId: 'alice',
        actorGroups: [],
        commandId,
      }),
    ).resolves.toEqual({ status: 'accepted', commandId });

    const resolved = await vi.waitFor(async () => {
      const details = await manager?.getRunDetails(managerRunId);
      const gate = details?.gates.find((entry) => entry.id === pending.id);
      expect(gate?.status).toBe('resolved');
      return gate;
    });
    expect(resolved).toMatchObject({
      status: 'resolved',
      acceptedAnswers: [{ actorId: 'alice', answer: 'approved', commandId }],
      resolution: { kind: 'answered', answer: 'approved' },
    });
    const events = await manager.getRunEvents(managerRunId, { limit: 100 });
    expect(events.items.some((event) => event.type === 'humanGate.conflict')).toBe(false);
  });

  it('AC-10 rejects a late answer after resolve and replays the accepted command after terminal', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: new ControlledRunExecutor(),
    });
    await manager.start();
    managerRunId = `rr11-ac10-${randomUUID()}`;
    await manager.startRun({
      runId: managerRunId,
      executionPlan: approvalPlan(),
      input: null,
    });
    const pending = await waitForPendingGate(manager, managerRunId);
    const acceptedCommandId = `cmd_${randomUUID()}` as const;
    const acceptedInput = {
      runId: managerRunId,
      gateInstanceId: pending.id,
      answer: 'approved',
      actorId: 'alice',
      actorGroups: [] as string[],
      commandId: acceptedCommandId,
    };
    await expect(manager.answerGate(acceptedInput)).resolves.toEqual({
      status: 'accepted',
      commandId: acceptedCommandId,
    });
    await expect(
      manager.answerGate({
        runId: managerRunId,
        gateInstanceId: pending.id,
        answer: 'rejected',
        actorId: 'bob',
        actorGroups: [],
        commandId: `cmd_${randomUUID()}`,
      }),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'gate_already_resolved' });

    await manager.waitForTerminal(managerRunId, { timeoutMs: 8_000 });
    await expect(manager.answerGate(acceptedInput)).resolves.toEqual({
      status: 'accepted',
      commandId: acceptedCommandId,
    });
    await expect(
      manager.answerGate({
        runId: managerRunId,
        gateInstanceId: pending.id,
        answer: 'rejected',
        actorId: 'carol',
        actorGroups: [],
        commandId: `cmd_${randomUUID()}`,
      }),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'run_already_terminal' });
  });

  it('AC-12 rejects a reused commandId whose answerGate payload differs, including actorGroups order', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: new ControlledRunExecutor(),
    });
    await manager.start();
    managerRunId = `rr11-ac12-${randomUUID()}`;
    await manager.startRun({
      runId: managerRunId,
      executionPlan: approvalPlan(),
      input: null,
    });
    const pending = await waitForPendingGate(manager, managerRunId);
    const commandId = `cmd_${randomUUID()}` as const;
    const accepted = {
      runId: managerRunId,
      gateInstanceId: pending.id,
      answer: 'approved',
      actorId: 'alice',
      actorGroups: ['approvers', 'operators'],
      commandId,
    };
    await expect(manager.answerGate(accepted)).resolves.toEqual({ status: 'accepted', commandId });
    await expect(manager.answerGate({ ...accepted, answer: 'rejected' })).rejects.toMatchObject({
      code: 'run_command_failed',
      commandId,
    });
    await expect(
      manager.answerGate({ ...accepted, actorGroups: ['operators', 'approvers'] }),
    ).rejects.toMatchObject({ code: 'run_command_failed', commandId });
  });

  it('AC-11 rejects a syntactically valid unknown gate instance as gate_already_resolved', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: new ControlledRunExecutor(),
    });
    await manager.start();
    managerRunId = `rr11-ac11-${randomUUID()}`;
    await manager.startRun({
      runId: managerRunId,
      executionPlan: approvalPlan(),
      input: null,
    });
    await waitForPendingGate(manager, managerRunId);
    await expect(
      manager.answerGate({
        runId: managerRunId,
        gateInstanceId: unknownGateInstanceId,
        answer: 'approved',
        actorId: 'alice',
        actorGroups: [],
        commandId: `cmd_${randomUUID()}`,
      }),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'gate_already_resolved' });
    const details = await manager.getRunDetails(managerRunId);
    expect(details?.run.status).toBe('running');
  });

  it('AC-13 cancels a gate inside a remaining:cancel parallel and rejects a later answer', async () => {
    manager = createRunManager({
      database: { url: testDatabaseUrl() },
      executor: new ControlledRunExecutor(),
    });
    await manager.start();
    managerRunId = `rr11-ac13-${randomUUID()}`;
    await manager.startRun({
      runId: managerRunId,
      executionPlan: cancelledSubtreePlan(),
      input: null,
    });
    const pending = await waitForPendingGate(manager, managerRunId);
    const cancelled = await vi.waitFor(async () => {
      const details = await manager?.getRunDetails(managerRunId);
      const gate = details?.gates.find((entry) => entry.id === pending.id);
      expect(gate).toMatchObject({ status: 'resolved', resolution: { kind: 'cancelled' } });
      expect(details?.run.status).toBe('running');
      if (gate?.status !== 'resolved') {
        throw new Error('Subtree gate was not resolved.');
      }
      return gate;
    });
    expect(cancelled.resolution).toEqual({ kind: 'cancelled' });
    await expect(
      manager.answerGate({
        runId: managerRunId,
        gateInstanceId: pending.id,
        answer: 'approved',
        actorId: 'alice',
        actorGroups: [],
        commandId: `cmd_${randomUUID()}`,
      }),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'gate_already_resolved' });
  });
});
