import type { RunStoreTransaction } from '../storage/index.js';
import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';
import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';
import { lifecycleSupport } from './lifecycle-support.js';

type AuthorityPhase =
  | { readonly attempt: 'start_committed'; readonly node: 'executing' }
  | { readonly attempt: 'unknown'; readonly node: 'unknown' }
  | { readonly attempt: 'reconciling'; readonly node: 'unknown' };

const { conflict, fault, invalid, loadAuthority, notFound, samePin } = lifecycleSupport;

const correlationIsStale = (
  observed: LifecycleAttemptAuthority,
  loaded: Extract<Awaited<ReturnType<typeof loadAuthority>>, { readonly kind: 'found' }>,
): boolean =>
  loaded.run.id !== observed.runId ||
  loaded.node.id !== observed.nodeInstanceId ||
  loaded.node.runId !== loaded.run.id ||
  loaded.node.activationId !== observed.activationId ||
  loaded.node.nodeKey !== observed.nodeKey ||
  loaded.attempt.id !== observed.attemptId ||
  loaded.attempt.runId !== loaded.run.id ||
  loaded.attempt.nodeInstanceId !== loaded.node.id ||
  loaded.attempt.dispatchIdempotencyKey !== observed.dispatchIdempotencyKey ||
  loaded.node.activeAttemptId !== loaded.attempt.id;

const revisionsAreStale = (
  observed: LifecycleAttemptAuthority,
  loaded: Extract<Awaited<ReturnType<typeof loadAuthority>>, { readonly kind: 'found' }>,
): boolean =>
  loaded.run.revision !== observed.expectedRunRevision ||
  loaded.node.revision !== observed.expectedNodeRevision ||
  loaded.attempt.revision !== observed.expectedAttemptRevision;

export const checkLifecycleAuthority = async (
  transaction: RunStoreTransaction,
  observed: LifecycleAttemptAuthority,
  phase: AuthorityPhase,
): Promise<
  | Extract<Awaited<ReturnType<typeof loadAuthority>>, { readonly kind: 'found' }>
  | { readonly result: LifecycleConflictResult | LifecycleFaultResult }
> => {
  const loaded = await loadAuthority(transaction, observed);
  if (loaded.kind === 'invalid_input') return { result: invalid() };
  if (loaded.kind === 'not_found') return { result: notFound() };
  if (correlationIsStale(observed, loaded)) {
    return {
      result: conflict({ code: 'STALE_FENCE', message: 'Lifecycle authority is stale.' }),
    };
  }
  if (!samePin(loaded.run.planPin, observed.planPin)) {
    return { result: fault('PLAN_MISMATCH', 'Authoritative Run plan pin differs.') };
  }
  const handoff = await transaction.getHandoff({
    attemptId: loaded.attempt.id,
    incumbentFencingToken: loaded.attempt.fencingToken,
  });
  if (handoff.kind === 'invalid_input') return { result: invalid() };
  if (
    loaded.attempt.managerIncarnationId !== observed.managerIncarnationId ||
    loaded.attempt.fencingToken !== observed.fencingToken ||
    handoff.kind === 'found'
  ) {
    return {
      result: conflict({ code: 'STALE_FENCE', message: 'Lifecycle authority is stale.' }),
    };
  }
  if (revisionsAreStale(observed, loaded)) {
    return {
      result: conflict({
        code: 'REVISION_CONFLICT',
        message: 'Lifecycle authority revision is stale.',
      }),
    };
  }
  if (
    (loaded.run.status !== 'running' && loaded.run.status !== 'cancelling') ||
    loaded.node.status !== phase.node ||
    loaded.attempt.status !== phase.attempt
  ) {
    return {
      result: conflict({ code: 'INVALID_STATE', message: 'Lifecycle state is incompatible.' }),
    };
  }
  if (
    !samePin(loaded.attempt.executorContractPin, observed.executorContractPin) ||
    loaded.attempt.executorConfigurationDigest !== observed.executorConfigurationDigest
  ) {
    return {
      result: conflict({
        code: 'INVALID_STATE',
        message: 'Lifecycle executor binding is incompatible.',
      }),
    };
  }
  if (
    loaded.attempt.leaseExpiresAt !== observed.leaseExpiresAt ||
    transaction.transactionNow >= loaded.attempt.leaseExpiresAt
  ) {
    return {
      result: conflict({ code: 'STALE_FENCE', message: 'Lifecycle lease is stale.' }),
    };
  }
  return loaded;
};
