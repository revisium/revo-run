import { applyDomainOperation } from '../domain/index.js';
import { snapshotLeasePolicy } from '../policy/index.js';
import type { RunStore } from '../storage/index.js';
import type { LifecycleRenewLeaseRequest } from './lifecycle-renew-lease-request.js';
import type { LifecycleRenewLeaseResult } from './lifecycle-renew-lease-result.js';
import { lifecycleSupport } from './lifecycle-support.js';

const {
  authority,
  authorityMatches,
  expectation,
  incumbentAuthority,
  invalid,
  loadAuthority,
  mapCursor,
  mapDomainError,
  mapNonCommit,
  notFound,
  conflict,
  safeAdd,
} = lifecycleSupport;
import { lifecycleValidation } from './lifecycle-validation.js';

export const renewLease = async (
  store: RunStore,
  request: LifecycleRenewLeaseRequest,
): Promise<LifecycleRenewLeaseResult> => {
  let leasePolicy;
  try {
    request = lifecycleValidation.renewRequest(request);
    leasePolicy = snapshotLeasePolicy(request.leasePolicy);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid();
    throw error;
  }
  return store.transaction(async (transaction) => {
    const loaded = await loadAuthority(transaction, request.authority);
    if (loaded.kind === 'invalid_input') return invalid();
    if (loaded.kind === 'not_found') return notFound();
    if (!authorityMatches(request.authority, loaded.run, loaded.node, loaded.attempt)) {
      return conflict({ code: 'STALE_FENCE', message: 'Lifecycle authority is stale.' });
    }
    let transition;
    try {
      transition = applyDomainOperation({
        attempt: loaded.attempt,
        authority: {
          ...incumbentAuthority(request.authority),
          transactionNow: transaction.transactionNow,
        },
        kind: 'renew_lease',
        nextLastHeartbeatAt: transaction.transactionNow,
        nextLeaseExpiresAt: safeAdd(transaction.transactionNow, leasePolicy.leaseDurationMs),
        node: loaded.node,
        run: loaded.run,
      });
    } catch (error) {
      return mapDomainError(error);
    }
    const result = await transaction.commit({
      authority: incumbentAuthority(request.authority),
      expected: {
        absentAttemptIds: [],
        absentNodes: [],
        absentOutputIds: [],
        attempts: [expectation(loaded.run, loaded.node, loaded.attempt).attempt],
        nodes: [expectation(loaded.run, loaded.node, loaded.attempt).node],
        run: expectation(loaded.run, loaded.node, loaded.attempt).run,
      },
      idempotency: null,
      kind: 'apply_incumbent_transition',
      leasePolicy,
      operation: 'renew_lease',
      transition,
    });
    if (result.kind !== 'committed') return mapNonCommit(result);
    return Object.freeze({
      cursor: mapCursor(result.cursor),
      kind: 'committed',
      transactionNow: result.transactionNow,
      value: Object.freeze({
        authority: (() => {
          const renewedNode = transition.nodes[0];
          const renewedAttempt = transition.attempts[0];
          if (renewedNode === undefined || renewedAttempt === undefined) {
            throw new TypeError('Renewal transition is incomplete.');
          }
          return authority(transition.run, renewedNode, renewedAttempt);
        })(),
        lastHeartbeatAt: result.transactionNow,
      }),
    });
  });
};
