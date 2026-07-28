import { canonicalizeJson } from '../policy/index.js';
import type { Attempt } from './attempt.js';

const same = (left: unknown, right: unknown): boolean =>
  canonicalizeJson(left) === canonicalizeJson(right);

export const validateRunProgressionAttemptDelta = (input: {
  readonly prior: Attempt;
  readonly next: Attempt;
  readonly transactionNow: number;
  readonly allowFaultChange?: boolean;
}): void => {
  const { next, prior, transactionNow } = input;
  if (!input.allowFaultChange && !same(next.fault, prior.fault)) {
    throw new TypeError('Run progression Attempt rewrites unverified fault evidence.');
  }
  const legalStatus =
    prior.status === next.status ||
    (prior.status === 'claimed' && next.status === 'cancelled') ||
    ((prior.status === 'start_committed' ||
      prior.status === 'unknown' ||
      prior.status === 'reconciling') &&
      (next.status === 'succeeded' || next.status === 'failed' || next.status === 'cancelled'));
  if (
    !legalStatus ||
    next.id !== prior.id ||
    next.runId !== prior.runId ||
    next.nodeInstanceId !== prior.nodeInstanceId ||
    next.ordinal !== prior.ordinal ||
    next.ownerLabel !== prior.ownerLabel ||
    next.managerIncarnationId !== prior.managerIncarnationId ||
    next.fencingToken !== prior.fencingToken ||
    next.leaseExpiresAt !== prior.leaseExpiresAt ||
    next.lastHeartbeatAt !== prior.lastHeartbeatAt ||
    next.dispatchIdempotencyKey !== prior.dispatchIdempotencyKey ||
    !same(next.executorContractPin, prior.executorContractPin) ||
    next.executorConfigurationDigest !== prior.executorConfigurationDigest ||
    next.createdAt !== prior.createdAt ||
    next.startCommittedAt !== prior.startCommittedAt ||
    next.revision !== prior.revision + 1 ||
    next.updatedAt !== transactionNow
  ) {
    throw new TypeError('Run progression Attempt delta rewrites immutable authority.');
  }
  if (
    (prior.progressionClosedAt === null
      ? next.progressionClosedAt !== null && next.progressionClosedAt !== transactionNow
      : next.progressionClosedAt !== prior.progressionClosedAt) ||
    (prior.terminalAt === null
      ? next.terminalAt !== null && next.terminalAt !== transactionNow
      : next.terminalAt !== prior.terminalAt) ||
    (next.progressionClosedAt !== null &&
      (next.startCommittedAt === null ||
        next.progressionClosedAt < next.startCommittedAt ||
        next.progressionClosedAt > transactionNow))
  ) {
    throw new TypeError('Run progression Attempt close time is invalid.');
  }
};
