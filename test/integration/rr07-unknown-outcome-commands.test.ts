import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RecoveryProcess } from '../support/process/recovery-process.js';

const path = 'main/publish';

const suspendUnknownOutcome = async () => {
  const runId = `rr07-unknown-${randomUUID()}`;
  const first = new RecoveryProcess('start', runId, 'rr-012', undefined, {
    input: null,
    instructions: [{ kind: 'outcomeUnknown' }],
  });
  const dispatch = await first.waitFor({ kind: 'dispatched', path, attemptOrdinal: 1 });
  assert(dispatch.attemptId !== undefined);
  await first.kill();

  const recovered = new RecoveryProcess('recover', runId, 'rr-012', undefined, {
    input: null,
    instructions: [{ kind: 'outcomeUnknown' }],
  });
  await recovered.waitFor({ kind: 'reconciled', path, attemptOrdinal: 1 });
  await recovered.waitFor({ kind: 'checkpointed', path });
  return { attemptId: dispatch.attemptId, first, recovered };
};

const resolveWhenPending = async (
  process: RecoveryProcess,
  attemptId: string,
  actorId: string,
  resolution: { readonly kind: 'markFailed' } | { readonly kind: 'retry' },
  count = 1,
) => {
  if (count > 20) {
    throw new Error('Unknown outcome never became pending at the root.');
  }
  process.resolveUnknownOutcome(attemptId, actorId, resolution);
  await process.waitForCount('commandReceipt', count);
  const receipt = process.commandReceipts().at(-1);
  if (receipt?.status === 'accepted') {
    return receipt;
  }
  expect(receipt).toMatchObject({
    status: 'rejected',
    reason: 'unknown_outcome_not_pending',
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  return resolveWhenPending(process, attemptId, actorId, resolution, count + 1);
};

describe('RR-07 unknown-outcome commands across process recovery', () => {
  it('marks an immutable unknown attempt failed with a fixed semantic result', async () => {
    const suspended = await suspendUnknownOutcome();
    try {
      await resolveWhenPending(suspended.recovered, suspended.attemptId, 'operator', {
        kind: 'markFailed',
      });
      await suspended.recovered.waitFor({ kind: 'terminal', status: 'failed' });
      await suspended.recovered.waitFor({ kind: 'stopped' });

      const details = suspended.recovered.reportedDetails();
      expect(details.attempts).toEqual([
        { ordinal: 1, status: 'outcomeUnknown', recovery: { reconciliationRound: 1 } },
      ]);
      expect(details.nodeStatuses).toEqual([{ path, status: 'failed' }]);
      expect(details.commands).toContainEqual(
        expect.objectContaining({
          actorId: 'operator',
          commandKind: 'resolveUnknownOutcome',
          decision: 'accepted',
          resolution: { kind: 'markFailed' },
          targetAttemptId: suspended.attemptId,
        }),
      );
      const failedEvent = suspended.recovered
        .reportedEvents()
        .find(({ type }) => type === 'nodeExecution.failed');
      expect(failedEvent?.data).toEqual(
        expect.objectContaining({
          attemptId: suspended.attemptId,
          errorCode: 'unknown_outcome_resolved_failed',
        }),
      );
    } finally {
      await suspended.first.kill();
      await suspended.recovered.kill();
    }
  }, 20_000);

  it('uses one retry permit for deterministic attempt n+1 and rejects a later resolution', async () => {
    const suspended = await suspendUnknownOutcome();
    try {
      const retryReceipt = await resolveWhenPending(
        suspended.recovered,
        suspended.attemptId,
        'operator',
        { kind: 'retry' },
      );
      const receiptCount = suspended.recovered.commandReceipts().length;
      expect(retryReceipt).toMatchObject({ status: 'accepted' });
      const retry = await suspended.recovered.waitFor({
        kind: 'dispatched',
        path,
        attemptOrdinal: 2,
      });
      expect(retry.attemptId).not.toBe(suspended.attemptId);

      suspended.recovered.resolveUnknownOutcome(suspended.attemptId, 'other-operator', {
        kind: 'markFailed',
      });
      await suspended.recovered.waitForCount('commandReceipt', receiptCount + 1);
      expect(suspended.recovered.commandReceipts().at(-1)).toMatchObject({
        status: 'rejected',
        reason: 'unknown_outcome_already_resolved',
      });

      suspended.recovered.complete(path, {
        outcome: 'completed',
        output: { release: { kind: 'json', value: 'retried' } },
      });
      await suspended.recovered.waitFor({ kind: 'terminal', status: 'succeeded' });
      await suspended.recovered.waitFor({ kind: 'stopped' });
      expect(suspended.recovered.dispatched(path, 2)).toBe(1);
      expect(suspended.recovered.reportedDetails().attempts).toEqual([
        { ordinal: 1, status: 'outcomeUnknown', recovery: { reconciliationRound: 1 } },
        expect.objectContaining({ ordinal: 2, status: 'completed' }),
      ]);
    } finally {
      await suspended.first.kill();
      await suspended.recovered.kill();
    }
  }, 20_000);
});
