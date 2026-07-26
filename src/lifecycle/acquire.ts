import { createAttempt, createRun, createRunNodeInstance } from '../domain/index.js';
import { snapshotLeasePolicy } from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type {
  RunStore,
  RunStoreIdempotencyIdentity,
  RunStoreIdempotencyRecord,
} from '../storage/index.js';
import type { LifecycleAcquireReceipt } from './lifecycle-acquire-receipt.js';
import type { LifecycleAcquireReplayReceipt } from './lifecycle-acquire-replay-receipt.js';
import type { LifecycleAcquireRequest } from './lifecycle-acquire-request.js';
import type { LifecycleAcquireResult } from './lifecycle-acquire-result.js';
import { lifecycleSupport } from './lifecycle-support.js';

const {
  authority,
  boundedString,
  conflict,
  expectation,
  invalid,
  mapAcquireReplay,
  mapCursor,
  mapNonCommit,
  notFound,
  safeAdd,
  samePin,
  sameSemanticRecordRequest,
} = lifecycleSupport;
import { lifecycleValidation } from './lifecycle-validation.js';

const mapAcquisitionReplay = (
  record: RunStoreIdempotencyRecord,
  identity: RunStoreIdempotencyIdentity,
  stableRequest: JsonValue,
  receipt: LifecycleAcquireReplayReceipt,
): LifecycleAcquireResult => {
  if (!sameSemanticRecordRequest(record, stableRequest)) {
    return conflict({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Acquisition idempotency key was reused with different semantics.',
    });
  }
  return mapAcquireReplay(record, identity, receipt);
};

export const acquire = async (
  store: RunStore,
  request: LifecycleAcquireRequest,
): Promise<LifecycleAcquireResult> => {
  let leasePolicy;
  try {
    request = lifecycleValidation.acquireRequest(request);
    boundedString(request.successorManagerIncarnationId);
    boundedString(request.idempotencyKey);
    leasePolicy = snapshotLeasePolicy(request.leasePolicy);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid();
    throw error;
  }
  if (request.successorManagerIncarnationId === request.candidate.attempt.managerIncarnationId) {
    return invalid();
  }
  return store.transaction(async (transaction) => {
    const candidate = request.candidate;
    const [runResult, nodeResult, attemptResult] = await Promise.all([
      transaction.getRun(candidate.run.runId),
      transaction.getNode(candidate.node.nodeInstanceId),
      transaction.getAttempt(candidate.attempt.attemptId),
    ]);
    if (
      runResult.kind === 'invalid_input' ||
      nodeResult.kind === 'invalid_input' ||
      attemptResult.kind === 'invalid_input'
    )
      return invalid();
    if (
      runResult.kind !== 'found' ||
      nodeResult.kind !== 'found' ||
      attemptResult.kind !== 'found'
    ) {
      return notFound();
    }
    const run = runResult.value;
    const node = nodeResult.value;
    const attempt = attemptResult.value;
    if (
      run.id !== candidate.run.runId ||
      !samePin(run.planPin, candidate.run.planPin) ||
      node.id !== candidate.node.nodeInstanceId ||
      node.runId !== run.id ||
      attempt.id !== candidate.attempt.attemptId ||
      attempt.runId !== run.id ||
      attempt.nodeInstanceId !== node.id
    ) {
      return conflict({ code: 'STALE_FENCE', message: 'Acquisition observation is stale.' });
    }
    const evidence =
      candidate.kind === 'handoff_attempt'
        ? { handoffId: candidate.handoffId, kind: 'handoff' as const }
        : { kind: 'lease_expired' as const };
    const identity = {
      key: request.idempotencyKey,
      operation: 'acquire_attempt' as const,
      runId: run.id,
      subjectId: attempt.id,
    };
    const stableRequest: JsonValue = {
      candidate: {
        attempt: {
          attemptId: candidate.attempt.attemptId,
          attemptPhase: candidate.attempt.attemptPhase,
          attemptRevision: candidate.attempt.attemptRevision,
          fencingToken: candidate.attempt.fencingToken,
          leaseExpiresAt: candidate.attempt.leaseExpiresAt,
          managerIncarnationId: candidate.attempt.managerIncarnationId,
        },
        eligibleAt: candidate.eligibleAt,
        handoffId: candidate.handoffId,
        kind: candidate.kind,
        node: {
          activeAttemptId: candidate.node.activeAttemptId,
          nodeInstanceId: candidate.node.nodeInstanceId,
          nodeRevision: candidate.node.nodeRevision,
        },
        run: {
          planPin: {
            digest: candidate.run.planPin.digest,
            id: candidate.run.planPin.id,
            revision: candidate.run.planPin.revision,
          },
          runId: candidate.run.runId,
          runRevision: candidate.run.runRevision,
        },
      },
      evidence,
      leasePolicy: {
        heartbeatIntervalMs: leasePolicy.heartbeatIntervalMs,
        leaseDurationMs: leasePolicy.leaseDurationMs,
      },
      successorManagerIncarnationId: request.successorManagerIncarnationId,
      version: 1,
    };
    const replay = await transaction.getIdempotency(identity);
    if (replay.kind === 'found') {
      try {
        return mapAcquisitionReplay(replay.value, identity, stableRequest, {
          attemptId: candidate.attempt.attemptId,
          nodeInstanceId: candidate.node.nodeInstanceId,
          recovery: candidate.attempt.attemptPhase === 'claimed' ? 'start' : 'reconcile',
          runId: candidate.run.runId,
          successorFencingToken: safeAdd(candidate.attempt.fencingToken, 1),
          successorManagerIncarnationId: request.successorManagerIncarnationId,
        });
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) return invalid();
        throw error;
      }
    }
    if (
      node.activeAttemptId !== attempt.id ||
      attempt.status !== candidate.attempt.attemptPhase ||
      attempt.managerIncarnationId !== candidate.attempt.managerIncarnationId ||
      attempt.fencingToken !== candidate.attempt.fencingToken ||
      attempt.leaseExpiresAt !== candidate.attempt.leaseExpiresAt
    ) {
      return conflict({ code: 'STALE_FENCE', message: 'Acquisition observation is stale.' });
    }
    if (
      run.revision !== candidate.run.runRevision ||
      node.revision !== candidate.node.nodeRevision ||
      attempt.revision !== candidate.attempt.attemptRevision
    )
      return conflict({
        code: 'REVISION_CONFLICT',
        message: 'Acquisition candidate is stale.',
      });
    let nextFence;
    let nextAttemptRevision;
    let nextRun;
    let nextNode;
    let nextAttempt;
    const recovery = attempt.status === 'claimed' ? ('start' as const) : ('reconcile' as const);
    const becomeUnknown = attempt.status === 'start_committed';
    try {
      nextFence = safeAdd(attempt.fencingToken, 1);
      nextAttemptRevision = safeAdd(attempt.revision, 1);
      nextRun = becomeUnknown
        ? createRun({
            ...run,
            revision: safeAdd(run.revision, 1),
            updatedAt: transaction.transactionNow,
          })
        : run;
      nextNode = becomeUnknown
        ? createRunNodeInstance({
            ...node,
            revision: safeAdd(node.revision, 1),
            status: 'unknown',
            updatedAt: transaction.transactionNow,
          })
        : node;
      nextAttempt = createAttempt({
        ...attempt,
        fault: becomeUnknown
          ? { code: 'UNKNOWN_OUTCOME', message: 'Execution ownership was lost after Start.' }
          : attempt.fault,
        fencingToken: nextFence,
        lastHeartbeatAt: transaction.transactionNow,
        leaseExpiresAt: safeAdd(transaction.transactionNow, leasePolicy.leaseDurationMs),
        managerIncarnationId: request.successorManagerIncarnationId,
        revision: nextAttemptRevision,
        status: becomeUnknown || attempt.status === 'reconciling' ? 'unknown' : attempt.status,
        updatedAt: transaction.transactionNow,
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) return invalid();
      throw error;
    }
    const replayReceipt: LifecycleAcquireReplayReceipt = Object.freeze({
      attemptId: attempt.id,
      nodeInstanceId: node.id,
      recovery,
      runId: run.id,
      successorFencingToken: nextFence,
      successorManagerIncarnationId: request.successorManagerIncarnationId,
    });
    const stableResult: JsonValue = {
      ...replayReceipt,
      attemptPhase: nextAttempt.status,
      nodePhase: nextNode.status,
    };
    const handoff =
      evidence.kind === 'handoff'
        ? {
            handoffId: evidence.handoffId,
            key: { attemptId: attempt.id, incumbentFencingToken: attempt.fencingToken },
            kind: 'named' as const,
          }
        : {
            key: { attemptId: attempt.id, incumbentFencingToken: attempt.fencingToken },
            kind: 'absent' as const,
          };
    const result = await transaction.commit({
      change: { attempt: nextAttempt, node: nextNode, run: nextRun },
      evidence,
      expected: {
        attempt: { ...expectation(run, node, attempt).attempt, handoff },
        node: expectation(run, node, attempt).node,
        run: expectation(run, node, attempt).run,
      },
      idempotency: {
        identity: {
          ...identity,
        },
        request: stableRequest,
        result: stableResult,
      },
      kind: 'acquire_attempt',
      leasePolicy,
      successorManagerIncarnationId: request.successorManagerIncarnationId,
    });
    if (result.kind === 'replayed') {
      try {
        return mapAcquisitionReplay(result.record, identity, stableRequest, replayReceipt);
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) return invalid();
        throw error;
      }
    }
    if (result.kind !== 'committed') return mapNonCommit(result);
    const receipt: LifecycleAcquireReceipt = Object.freeze({
      authority: authority(nextRun, nextNode, nextAttempt),
      evidence,
      recovery,
    });
    return Object.freeze({
      cursor: mapCursor(result.cursor),
      kind: 'committed',
      transactionNow: result.transactionNow,
      value: receipt,
    });
  });
};
