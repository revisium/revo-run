import { applyDomainOperation, createAttempt } from '../domain/index.js';
import type { Run, RunNodeInstance } from '../domain/index.js';
import { snapshotLeasePolicy, snapshotRunExecutionPlanDocument } from '../policy/index.js';
import type {
  JsonValue,
  LeasePolicy,
  RunExecutionPlanDocument,
  RunExecutionPlanExecutorBinding,
} from '../spec/index.js';
import type {
  RunStore,
  RunStoreCommitResult,
  RunStoreIdempotencyIdentity,
  RunStoreIdempotencyRecord,
  RunStoreTransaction,
} from '../storage/index.js';
import type { LifecycleClaimReceipt } from './lifecycle-claim-receipt.js';
import type { LifecycleClaimReplayReceipt } from './lifecycle-claim-replay-receipt.js';
import type { LifecycleClaimRequest } from './lifecycle-claim-request.js';
import type { LifecycleClaimResult } from './lifecycle-claim-result.js';
import { lifecycleSupport } from './lifecycle-support.js';

const {
  authority,
  boundedString,
  conflict,
  fault,
  invalid,
  mapCursor,
  mapNonCommit,
  notFound,
  numberMember,
  recordValue,
  safeAdd,
  samePin,
  sameSemanticRecordRequest,
  textMember,
  validateReplayRecord,
} = lifecycleSupport;
import { lifecycleValidation } from './lifecycle-validation.js';

const mapClaimReplay = (
  record: RunStoreIdempotencyRecord,
  identity: RunStoreIdempotencyIdentity,
  stableRequest: JsonValue,
  expected: {
    readonly attemptId: string;
    readonly maximumAttempts: number;
    readonly nodeInstanceId: string;
    readonly runId: string;
  },
): LifecycleClaimResult => {
  if (!sameSemanticRecordRequest(record, stableRequest)) {
    return conflict({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Claim idempotency key was reused with different semantics.',
    });
  }
  validateReplayRecord(record, identity);
  const result = recordValue(record, [
    'attemptId',
    'attemptPhase',
    'fencingToken',
    'nodeInstanceId',
    'nodePhase',
    'ordinal',
    'runId',
  ]);
  const fencingToken = numberMember(result, 'fencingToken');
  const receipt: LifecycleClaimReplayReceipt = Object.freeze({
    attemptId: textMember(result, 'attemptId'),
    fencingToken: 1,
    nodeInstanceId: textMember(result, 'nodeInstanceId'),
    ordinal: numberMember(result, 'ordinal'),
    runId: textMember(result, 'runId'),
  });
  if (
    textMember(result, 'attemptPhase') !== 'claimed' ||
    textMember(result, 'nodePhase') !== 'executing' ||
    fencingToken !== 1 ||
    receipt.attemptId !== expected.attemptId ||
    receipt.nodeInstanceId !== expected.nodeInstanceId ||
    receipt.runId !== expected.runId ||
    receipt.ordinal < 0 ||
    receipt.ordinal >= expected.maximumAttempts
  ) {
    throw new TypeError('Claim idempotency result is invalid.');
  }
  return Object.freeze({
    committedAt: record.committedAt,
    cursor: mapCursor(record.cursor),
    kind: 'replayed',
    value: receipt,
  });
};

const mapClaimReplaySafely = (
  record: RunStoreIdempotencyRecord,
  identity: RunStoreIdempotencyIdentity,
  stableRequest: JsonValue,
  expected: Parameters<typeof mapClaimReplay>[3],
): LifecycleClaimResult => {
  try {
    return mapClaimReplay(record, identity, stableRequest, expected);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid();
    throw error;
  }
};

const claimCandidateIsStale = (
  request: LifecycleClaimRequest,
  run: Run,
  node: RunNodeInstance,
): boolean =>
  run.id !== request.candidate.run.runId ||
  !samePin(run.planPin, request.candidate.run.planPin) ||
  node.id !== request.candidate.node.nodeInstanceId ||
  node.nodeKey !== request.candidate.node.nodeKey ||
  node.runId !== run.id;

const claimAuthorityIsStale = (
  request: LifecycleClaimRequest,
  run: Run,
  node: RunNodeInstance,
): boolean =>
  run.revision !== request.candidate.run.runRevision ||
  node.revision !== request.candidate.node.nodeRevision ||
  node.activeAttemptId !== null;

const claimIsEligible = (transactionNow: number, run: Run, node: RunNodeInstance): boolean =>
  run.status === 'running' &&
  (node.status === 'ready' ||
    (node.status === 'retry_waiting' &&
      node.retryAvailableAt !== null &&
      node.retryAvailableAt <= transactionNow));

const selectBinding = (
  plan: RunExecutionPlanDocument,
  node: RunNodeInstance,
): RunExecutionPlanExecutorBinding | null => {
  const matches = plan.executorBindings.filter((item) => item.nodeKey === node.nodeKey);
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

const nextClaimOrdinal = async (
  transaction: RunStoreTransaction,
  run: Run,
  node: RunNodeInstance,
  maximumAttempts: number,
): Promise<number | LifecycleClaimResult> => {
  const attempts = await transaction.listAttempts({
    cursor: null,
    limit: 100,
    managerIncarnationId: null,
    nodeInstanceId: node.id,
    runId: run.id,
    statuses: [
      'claimed',
      'start_committed',
      'unknown',
      'reconciling',
      'succeeded',
      'failed',
      'cancelled',
    ],
  });
  if (attempts.kind === 'invalid_input') return invalid();
  if (attempts.page.next !== null) {
    return conflict({ code: 'INVALID_STATE', message: 'Attempt history exceeds its bound.' });
  }
  const ordinals = new Set<number>();
  let maximum = -1;
  for (const attempt of attempts.page.items) {
    if (attempt.ordinal < 0 || attempt.ordinal >= 100 || ordinals.has(attempt.ordinal)) {
      return conflict({ code: 'INVALID_STATE', message: 'Attempt history is invalid.' });
    }
    ordinals.add(attempt.ordinal);
    maximum = Math.max(maximum, attempt.ordinal);
  }
  const ordinal = maximum + 1;
  return ordinal >= maximumAttempts
    ? conflict({ code: 'INVALID_STATE', message: 'Attempt policy is exhausted.' })
    : ordinal;
};

const mapClaimCommit = (
  result: RunStoreCommitResult,
  transition: ReturnType<typeof applyDomainOperation>,
  ordinal: number,
  replayIdentity: RunStoreIdempotencyIdentity,
  stableRequest: JsonValue,
  expectedReplay: Parameters<typeof mapClaimReplay>[3],
): LifecycleClaimResult => {
  if (result.kind === 'replayed') {
    return mapClaimReplaySafely(result.record, replayIdentity, stableRequest, expectedReplay);
  }
  if (result.kind !== 'committed') return mapNonCommit(result);
  const claimedNode = transition.nodes[0];
  const claimedAttempt = transition.attempts[0];
  if (claimedNode === undefined || claimedAttempt === undefined) {
    throw new TypeError('Claim transition is incomplete.');
  }
  const claimedAuthority = authority(transition.run, claimedNode, claimedAttempt);
  if (claimedAuthority.attemptPhase !== 'claimed' || claimedAuthority.nodePhase !== 'executing') {
    throw new TypeError('Claim transition is invalid.');
  }
  const receipt: LifecycleClaimReceipt = Object.freeze({
    authority: Object.freeze({
      ...claimedAuthority,
      attemptPhase: 'claimed',
      nodePhase: 'executing',
    }),
    ordinal,
  });
  return Object.freeze({
    cursor: mapCursor(result.cursor),
    kind: 'committed',
    transactionNow: result.transactionNow,
    value: receipt,
  });
};

export const claim = async (
  store: RunStore,
  request: LifecycleClaimRequest,
): Promise<LifecycleClaimResult> => {
  let plan;
  let leasePolicy;
  try {
    request = lifecycleValidation.claimRequest(request);
    boundedString(request.generatedAttemptId);
    boundedString(request.generatedDispatchIdempotencyKey);
    boundedString(request.managerIncarnationId);
    boundedString(request.ownerLabel, 512);
    boundedString(request.idempotencyKey);
    leasePolicy = snapshotLeasePolicy(request.leasePolicy);
    plan = snapshotRunExecutionPlanDocument(request.planDocument);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid();
    throw error;
  }
  if (!samePin(plan.pin, request.candidate.run.planPin)) {
    return fault('PLAN_MISMATCH', 'Execution plan pin does not match the discovered Run.');
  }
  return store.transaction((transaction) =>
    claimInTransaction(transaction, request, leasePolicy, plan),
  );
};

const claimInTransaction = async (
  transaction: RunStoreTransaction,
  request: LifecycleClaimRequest,
  leasePolicy: LeasePolicy,
  plan: RunExecutionPlanDocument,
): Promise<LifecycleClaimResult> => {
  let binding: RunExecutionPlanExecutorBinding;
  const [runResult, nodeResult] = await Promise.all([
    transaction.getRun(request.candidate.run.runId),
    transaction.getNode(request.candidate.node.nodeInstanceId),
  ]);
  if (runResult.kind === 'invalid_input' || nodeResult.kind === 'invalid_input') {
    return invalid();
  }
  if (runResult.kind !== 'found' || nodeResult.kind !== 'found') return notFound();
  const run = runResult.value;
  const node = nodeResult.value;
  if (claimCandidateIsStale(request, run, node)) {
    return conflict({ code: 'REVISION_CONFLICT', message: 'Claim candidate is stale.' });
  }
  if (!samePin(run.planPin, plan.pin)) {
    return fault('PLAN_MISMATCH', 'Execution plan pin does not match the authoritative Run.');
  }
  const selectedBinding = selectBinding(plan, node);
  if (selectedBinding === null) {
    return fault(
      'PLAN_MISMATCH',
      'Execution plan has no exact binding for the authoritative node.',
    );
  }
  binding = selectedBinding;
  const replayIdentity = {
    key: request.idempotencyKey,
    operation: 'claim_attempt' as const,
    runId: run.id,
    subjectId: node.id,
  };
  const replay = await transaction.getIdempotency(replayIdentity);
  const stableRequest: JsonValue = {
    binding: {
      configurationDigest: binding.configurationDigest,
      executor: {
        adapterId: binding.executor.adapterId,
        digest: binding.executor.digest,
        revision: binding.executor.revision,
      },
      idempotentExecution: binding.idempotentExecution,
      maximumAttempts: binding.retryPolicy.maximumAttempts,
      nodeKey: binding.nodeKey,
    },
    candidate: {
      activeAttemptId: request.candidate.node.activeAttemptId,
      eligibleAt: request.candidate.eligibleAt,
      kind: request.candidate.kind,
      nodeInstanceId: node.id,
      nodeRevision: request.candidate.node.nodeRevision,
      runId: run.id,
      runRevision: request.candidate.run.runRevision,
    },
    generatedAttemptId: request.generatedAttemptId,
    generatedDispatchIdempotencyKey: request.generatedDispatchIdempotencyKey,
    leasePolicy: {
      heartbeatIntervalMs: leasePolicy.heartbeatIntervalMs,
      leaseDurationMs: leasePolicy.leaseDurationMs,
    },
    managerIncarnationId: request.managerIncarnationId,
    ownerLabel: request.ownerLabel,
    planPin: {
      digest: plan.pin.digest,
      id: plan.pin.id,
      revision: plan.pin.revision,
    },
    version: 1,
  };
  if (replay.kind === 'found') {
    return mapClaimReplaySafely(replay.value, replayIdentity, stableRequest, {
      attemptId: request.generatedAttemptId,
      maximumAttempts: binding.retryPolicy.maximumAttempts,
      nodeInstanceId: node.id,
      runId: run.id,
    });
  }
  if (claimAuthorityIsStale(request, run, node)) {
    return conflict({ code: 'REVISION_CONFLICT', message: 'Claim candidate is stale.' });
  }
  if (!claimIsEligible(transaction.transactionNow, run, node)) {
    return conflict({
      code: 'INVALID_STATE',
      message: 'Run or node is not eligible to be claimed.',
    });
  }
  const ordinalResult = await nextClaimOrdinal(
    transaction,
    run,
    node,
    binding.retryPolicy.maximumAttempts,
  );
  if (typeof ordinalResult !== 'number') return ordinalResult;
  const ordinal = ordinalResult;
  let attempt;
  let transition;
  try {
    attempt = createAttempt({
      createdAt: transaction.transactionNow,
      dispatchIdempotencyKey: request.generatedDispatchIdempotencyKey,
      executorConfigurationDigest: binding.configurationDigest,
      executorContractPin: binding.executor,
      fault: null,
      fencingToken: 1,
      id: request.generatedAttemptId,
      lastHeartbeatAt: transaction.transactionNow,
      leaseExpiresAt: safeAdd(transaction.transactionNow, leasePolicy.leaseDurationMs),
      managerIncarnationId: request.managerIncarnationId,
      nodeInstanceId: node.id,
      ordinal,
      ownerLabel: request.ownerLabel,
      progressionClosedAt: null,
      revision: 0,
      runId: run.id,
      startCommittedAt: null,
      status: 'claimed',
      terminalAt: null,
      updatedAt: transaction.transactionNow,
    });
    transition = applyDomainOperation({
      attempt,
      expectedNodeRevision: node.revision,
      expectedRunRevision: run.revision,
      kind: 'claim',
      node,
      run,
      transactionNow: transaction.transactionNow,
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return invalid();
    throw error;
  }
  const stableResult: JsonValue = {
    attemptId: attempt.id,
    attemptPhase: 'claimed',
    fencingToken: 1,
    nodeInstanceId: node.id,
    nodePhase: 'executing',
    ordinal,
    runId: run.id,
  };
  const result = await transaction.commit({
    expected: {
      absentAttemptId: attempt.id,
      absentNodes: [],
      absentOutputIds: [],
      node: { activeAttemptId: null, nodeInstanceId: node.id, revision: node.revision },
      run: { planPin: run.planPin, revision: run.revision, runId: run.id },
    },
    idempotency: { identity: replayIdentity, request: stableRequest, result: stableResult },
    kind: 'claim_attempt',
    leasePolicy,
    operation: 'claim',
    transition,
  });
  return mapClaimCommit(result, transition, ordinal, replayIdentity, stableRequest, {
    attemptId: request.generatedAttemptId,
    maximumAttempts: binding.retryPolicy.maximumAttempts,
    nodeInstanceId: node.id,
    runId: run.id,
  });
};
