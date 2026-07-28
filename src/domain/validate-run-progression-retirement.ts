import type { Attempt } from './attempt.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunProgressionProjection } from './run-progression-projection.js';

const inactiveStatuses = new Set([
  'ready',
  'retry_waiting',
  'gate_waiting',
  'join_waiting',
  'selector_waiting',
]);

export const validateRunProgressionRetirement = (input: {
  readonly attempt: Attempt | null;
  readonly node: RunNodeInstance;
  readonly projection: RunProgressionProjection;
  readonly transactionNow: number;
}): void => {
  const priorNode = input.projection.nodes.find((node) => node.id === input.node.id);
  if (priorNode === undefined) {
    throw new TypeError('Run progression retirement target is missing.');
  }
  if (inactiveStatuses.has(priorNode.status)) {
    if (
      priorNode.activeAttemptId !== null ||
      input.node.status !== 'retired' ||
      input.node.activeAttemptId !== null ||
      input.attempt !== null
    ) {
      throw new TypeError('Inactive Run progression retirement is invalid.');
    }
    return;
  }

  const priorAttempt = input.projection.attempts.find(
    (attempt) => attempt.id === priorNode.activeAttemptId,
  );
  if (
    priorAttempt === undefined ||
    input.attempt?.id !== priorAttempt.id ||
    input.attempt.revision !== priorAttempt.revision + 1 ||
    input.attempt.updatedAt !== input.transactionNow
  ) {
    throw new TypeError('Active Run progression retirement authority is invalid.');
  }

  if (priorAttempt.status === 'claimed') {
    if (
      priorNode.status !== 'executing' ||
      input.node.status !== 'retired' ||
      input.node.activeAttemptId !== null ||
      input.attempt.status !== 'cancelled' ||
      input.attempt.terminalAt !== input.transactionNow ||
      input.attempt.progressionClosedAt !== null
    ) {
      throw new TypeError('Claimed Run progression retirement is invalid.');
    }
    return;
  }

  if (
    (priorNode.status !== 'executing' && priorNode.status !== 'unknown') ||
    (priorAttempt.status !== 'start_committed' &&
      priorAttempt.status !== 'unknown' &&
      priorAttempt.status !== 'reconciling') ||
    input.node.status !== 'retiring' ||
    input.node.activeAttemptId !== priorAttempt.id ||
    input.attempt.status !== priorAttempt.status ||
    input.attempt.terminalAt !== null ||
    input.attempt.progressionClosedAt !== input.transactionNow
  ) {
    throw new TypeError('Started Run progression retirement is invalid.');
  }
};
