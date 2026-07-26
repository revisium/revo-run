import type { Attempt } from './attempt.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { Run } from './run.js';

const terminalNodeStatuses = new Set(['succeeded', 'failed', 'cancelled']);
const activeAttemptStatuses = new Set(['claimed', 'start_committed', 'unknown', 'reconciling']);

const compatible = (node: RunNodeInstance, attempt: Attempt): boolean =>
  (node.status === 'executing' &&
    (attempt.status === 'claimed' || attempt.status === 'start_committed')) ||
  (node.status === 'unknown' && (attempt.status === 'unknown' || attempt.status === 'reconciling'));

export const validateRunAggregate = (aggregate: {
  readonly run: Run;
  readonly nodes: readonly RunNodeInstance[];
  readonly attempts: readonly Attempt[];
}): void => {
  const nodeIds = new Set<string>();
  const activationCoordinates = new Set<string>();
  const attemptIds = new Set<string>();
  const referencedAttempts = new Set<string>();

  for (const attempt of aggregate.attempts) {
    if (
      attempt.runId !== aggregate.run.id ||
      attemptIds.has(attempt.id) ||
      !aggregate.nodes.some((node) => node.id === attempt.nodeInstanceId)
    ) {
      throw new TypeError('Attempt aggregate identity is invalid.');
    }
    attemptIds.add(attempt.id);
  }

  for (const node of aggregate.nodes) {
    const activationCoordinate = `${node.runId}\u0000${node.forkScopeKey}\u0000${node.activationKey}`;
    if (
      node.runId !== aggregate.run.id ||
      nodeIds.has(node.id) ||
      activationCoordinates.has(activationCoordinate)
    ) {
      throw new TypeError('Run node aggregate identity is invalid.');
    }
    nodeIds.add(node.id);
    activationCoordinates.add(activationCoordinate);

    if (node.activeAttemptId === null) continue;
    const attempt = aggregate.attempts.find((candidate) => candidate.id === node.activeAttemptId);
    if (
      attempt === undefined ||
      attempt.nodeInstanceId !== node.id ||
      !compatible(node, attempt) ||
      referencedAttempts.has(attempt.id)
    ) {
      throw new TypeError('Run node active Attempt authority is invalid.');
    }
    referencedAttempts.add(attempt.id);
  }

  for (const attempt of aggregate.attempts) {
    if (activeAttemptStatuses.has(attempt.status) !== referencedAttempts.has(attempt.id)) {
      throw new TypeError('Attempt live authority is invalid.');
    }
  }

  if (
    aggregate.run.status === 'succeeded' ||
    aggregate.run.status === 'failed' ||
    aggregate.run.status === 'cancelled'
  ) {
    if (
      aggregate.nodes.some(
        (node) => !terminalNodeStatuses.has(node.status) || node.activeAttemptId !== null,
      )
    ) {
      throw new TypeError('Terminal Run contains non-terminal node authority.');
    }
  }
};
