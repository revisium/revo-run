import type { Attempt, Run, RunNodeInstance } from '../domain/index.js';
import type { RunConflict, RunFault } from '../errors/index.js';
import { canonicalizeJson, snapshotPortableJsonValue } from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type {
  RunStoreCommitResult,
  RunStoreDiscoveryCandidate,
  RunStoreIdempotencyIdentity,
  RunStoreIdempotencyRecord,
  RunStoreTransaction,
} from '../storage/index.js';
import type { LifecycleAcquireReplayReceipt } from './lifecycle-acquire-replay-receipt.js';
import type { LifecycleAcquireResult } from './lifecycle-acquire-result.js';
import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';
import type { LifecycleDiscoveryCandidate } from './lifecycle-discovery-candidate.js';
import type { LifecycleDiscoveryCursor } from './lifecycle-discovery-cursor.js';
import type { LifecycleHandoffReceipt } from './lifecycle-handoff-receipt.js';
import type { LifecycleWriteHandoffResult } from './lifecycle-write-handoff-result.js';

const fault = (
  code: RunFault['code'],
  message: string,
): { readonly kind: 'fault'; readonly fault: RunFault } =>
  Object.freeze({ fault: Object.freeze({ code, message }), kind: 'fault' });

const invalid = (): { readonly kind: 'fault'; readonly fault: RunFault } =>
  fault('INVALID_INPUT', 'Lifecycle input is invalid.');

const notFound = (): { readonly kind: 'fault'; readonly fault: RunFault } =>
  fault('NOT_FOUND', 'Lifecycle authority was not found.');

const conflict = (value: RunConflict) =>
  Object.freeze({ conflict: Object.freeze({ ...value }), kind: 'conflict' as const });

const boundedString = (value: unknown, maximumBytes = 256): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new TypeError('INVALID_INPUT');
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new TypeError('INVALID_INPUT');
    }
  }
  return value;
};

const safeAdd = (left: number, right: number): number => {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError('INVALID_INPUT');
  return result;
};

const samePin = (
  left: {
    readonly id?: string;
    readonly adapterId?: string;
    readonly revision: string;
    readonly digest: string;
  },
  right: {
    readonly id?: string;
    readonly adapterId?: string;
    readonly revision: string;
    readonly digest: string;
  },
): boolean =>
  left.id === right.id &&
  left.adapterId === right.adapterId &&
  left.revision === right.revision &&
  left.digest === right.digest;

const mapCursor = (cursor: { readonly runId: string; readonly sequence: number }) =>
  Object.freeze({ runId: cursor.runId, sequence: cursor.sequence });

const validateReplayRecord = (
  record: RunStoreIdempotencyRecord,
  expected: RunStoreIdempotencyIdentity,
): void => {
  if (
    !Number.isSafeInteger(record.committedAt) ||
    record.committedAt < 0 ||
    !Number.isSafeInteger(record.cursor.sequence) ||
    record.cursor.sequence < 0 ||
    record.cursor.runId !== expected.runId ||
    record.identity.key !== expected.key ||
    record.identity.operation !== expected.operation ||
    record.identity.runId !== expected.runId ||
    record.identity.subjectId !== expected.subjectId
  ) {
    throw new TypeError('Store idempotency record is invalid.');
  }
};

const mapDiscoveryCursor = (
  cursor: {
    readonly kinds: readonly LifecycleDiscoveryCursor['kinds'][number][];
    readonly renewal: LifecycleDiscoveryCursor['renewal'];
    readonly highWatermark: number;
    readonly last: LifecycleDiscoveryCursor['last'];
  } | null,
): LifecycleDiscoveryCursor | null =>
  cursor === null
    ? null
    : Object.freeze({
        highWatermark: cursor.highWatermark,
        kinds: Object.freeze([...cursor.kinds]),
        last: Object.freeze({ ...cursor.last }),
        renewal:
          cursor.renewal === null
            ? null
            : Object.freeze({
                leasePolicy: Object.freeze({ ...cursor.renewal.leasePolicy }),
                managerIncarnationId: cursor.renewal.managerIncarnationId,
              }),
      });

const isDiscoveryRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const snapshotObservedNode = (
  value: NonNullable<RunStoreDiscoveryCandidate['observedNode']>,
): {
  readonly activeAttemptId: string | null;
  readonly nodeInstanceId: string;
  readonly nodeKey: string;
  readonly nodeRevision: number;
} => {
  const snapshot = snapshotPortableJsonValue(value);
  if (!isDiscoveryRecord(snapshot)) {
    throw new TypeError('Store discovery node is invalid.');
  }
  const keys = Object.keys(snapshot);
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        key !== 'activeAttemptId' &&
        key !== 'nodeInstanceId' &&
        key !== 'nodeKey' &&
        key !== 'nodeRevision',
    )
  ) {
    throw new TypeError('Store discovery node is invalid.');
  }
  const activeAttemptId = snapshot['activeAttemptId'];
  const nodeRevision = snapshot['nodeRevision'];
  if (activeAttemptId !== null && typeof activeAttemptId !== 'string') {
    throw new TypeError('Store discovery node is invalid.');
  }
  if (typeof nodeRevision !== 'number' || !Number.isSafeInteger(nodeRevision) || nodeRevision < 0) {
    throw new TypeError('Store discovery node is invalid.');
  }
  return Object.freeze({
    activeAttemptId: activeAttemptId === null ? null : boundedString(activeAttemptId),
    nodeInstanceId: boundedString(snapshot['nodeInstanceId']),
    nodeKey: boundedString(snapshot['nodeKey']),
    nodeRevision,
  });
};

const mapCandidate = (candidate: RunStoreDiscoveryCandidate): LifecycleDiscoveryCandidate => {
  const run = Object.freeze({
    planPin: Object.freeze({ ...candidate.observedRun.planPin }),
    runId: candidate.observedRun.runId,
    runRevision: candidate.observedRun.runRevision,
  });
  if (candidate.observedNode === null) {
    return Object.freeze({
      attempt: null,
      eligibleAt: candidate.eligibleAt,
      handoffId: null,
      kind: candidate.kind,
      node: null,
      run,
    });
  }
  const node = snapshotObservedNode(candidate.observedNode);
  if (candidate.observedAttempt === null) {
    return Object.freeze({
      attempt: null,
      eligibleAt: candidate.eligibleAt,
      handoffId: null,
      kind: 'claimable_node',
      node: Object.freeze({ ...node, activeAttemptId: null }),
      run,
    });
  }
  const attempt = Object.freeze({
    attemptId: candidate.observedAttempt.attemptId,
    attemptPhase: candidate.observedAttempt.attemptStatus,
    attemptRevision: candidate.observedAttempt.attemptRevision,
    fencingToken: candidate.observedAttempt.fencingToken,
    leaseExpiresAt: candidate.observedAttempt.leaseExpiresAt,
    managerIncarnationId: candidate.observedAttempt.managerIncarnationId,
  });
  if (candidate.kind === 'handoff_attempt') {
    return Object.freeze({
      attempt,
      eligibleAt: candidate.eligibleAt,
      handoffId: candidate.handoffId,
      kind: candidate.kind,
      node: Object.freeze({ ...node, activeAttemptId: attempt.attemptId }),
      run,
    });
  }
  return Object.freeze({
    attempt,
    eligibleAt: candidate.eligibleAt,
    handoffId: null,
    kind: candidate.kind,
    node: Object.freeze({ ...node, activeAttemptId: attempt.attemptId }),
    run,
  });
};

const authority = (
  run: Run,
  node: RunNodeInstance,
  attempt: Attempt,
): LifecycleAttemptAuthority => {
  if (
    attempt.status !== 'claimed' &&
    attempt.status !== 'start_committed' &&
    attempt.status !== 'unknown' &&
    attempt.status !== 'reconciling'
  ) {
    throw new TypeError('Attempt is not active.');
  }
  if (node.status !== 'executing' && node.status !== 'unknown') {
    throw new TypeError('Node is not active.');
  }
  return Object.freeze({
    activationId: node.activationId,
    attemptId: attempt.id,
    attemptPhase: attempt.status,
    dispatchIdempotencyKey: attempt.dispatchIdempotencyKey,
    executorConfigurationDigest: attempt.executorConfigurationDigest,
    executorContractPin: Object.freeze({ ...attempt.executorContractPin }),
    expectedAttemptRevision: attempt.revision,
    expectedNodeRevision: node.revision,
    expectedRunRevision: run.revision,
    fencingToken: attempt.fencingToken,
    leaseExpiresAt: attempt.leaseExpiresAt,
    managerIncarnationId: attempt.managerIncarnationId,
    nodeInstanceId: node.id,
    nodeKey: node.nodeKey,
    nodePhase: node.status,
    planPin: Object.freeze({ ...run.planPin }),
    runId: run.id,
  });
};

const expectation = (run: Run, node: RunNodeInstance, attempt: Attempt) => ({
  attempt: {
    attemptId: attempt.id,
    fencingToken: attempt.fencingToken,
    handoff: {
      key: { attemptId: attempt.id, incumbentFencingToken: attempt.fencingToken },
      kind: 'absent' as const,
    },
    leaseExpiresAt: attempt.leaseExpiresAt,
    managerIncarnationId: attempt.managerIncarnationId,
    revision: attempt.revision,
    status: attempt.status,
  },
  node: {
    activeAttemptId: node.activeAttemptId,
    nodeInstanceId: node.id,
    revision: node.revision,
  },
  run: { planPin: run.planPin, revision: run.revision, runId: run.id },
});

const incumbentAuthority = (value: LifecycleAttemptAuthority) =>
  Object.freeze({
    attemptId: value.attemptId,
    executorConfigurationDigest: value.executorConfigurationDigest,
    executorContractPin: value.executorContractPin,
    expectedAttemptRevision: value.expectedAttemptRevision,
    expectedNodeRevision: value.expectedNodeRevision,
    expectedRunRevision: value.expectedRunRevision,
    fencingToken: value.fencingToken,
    managerIncarnationId: value.managerIncarnationId,
  });

const loadAuthority = async (
  transaction: RunStoreTransaction,
  observed: LifecycleAttemptAuthority,
): Promise<
  | {
      readonly kind: 'found';
      readonly run: Run;
      readonly node: RunNodeInstance;
      readonly attempt: Attempt;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_input' }
> => {
  const [runResult, nodeResult, attemptResult] = await Promise.all([
    transaction.getRun(observed.runId),
    transaction.getNode(observed.nodeInstanceId),
    transaction.getAttempt(observed.attemptId),
  ]);
  if (
    runResult.kind === 'invalid_input' ||
    nodeResult.kind === 'invalid_input' ||
    attemptResult.kind === 'invalid_input'
  ) {
    return Object.freeze({ kind: 'invalid_input' });
  }
  if (runResult.kind !== 'found' || nodeResult.kind !== 'found' || attemptResult.kind !== 'found') {
    return Object.freeze({ kind: 'not_found' });
  }
  return Object.freeze({
    attempt: attemptResult.value,
    kind: 'found',
    node: nodeResult.value,
    run: runResult.value,
  });
};

const isJsonRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const recordValue = (
  record: RunStoreIdempotencyRecord,
  keys: readonly string[],
): Readonly<Record<string, JsonValue>> => {
  const value = record.result;
  if (
    !isJsonRecord(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new TypeError('Store idempotency result is invalid.');
  }
  return value;
};

const authorityMatches = (
  observed: LifecycleAttemptAuthority,
  run: Run,
  node: RunNodeInstance,
  attempt: Attempt,
): boolean =>
  observed.runId === run.id &&
  observed.nodeInstanceId === node.id &&
  observed.activationId === node.activationId &&
  observed.nodeKey === node.nodeKey &&
  observed.attemptId === attempt.id &&
  observed.attemptPhase === attempt.status &&
  observed.nodePhase === node.status &&
  observed.expectedRunRevision === run.revision &&
  observed.expectedNodeRevision === node.revision &&
  observed.expectedAttemptRevision === attempt.revision &&
  observed.managerIncarnationId === attempt.managerIncarnationId &&
  observed.fencingToken === attempt.fencingToken &&
  observed.leaseExpiresAt === attempt.leaseExpiresAt &&
  observed.dispatchIdempotencyKey === attempt.dispatchIdempotencyKey &&
  samePin(observed.planPin, run.planPin) &&
  samePin(observed.executorContractPin, attempt.executorContractPin) &&
  observed.executorConfigurationDigest === attempt.executorConfigurationDigest &&
  node.activeAttemptId === attempt.id;

const authorityJson = (value: LifecycleAttemptAuthority): JsonValue => ({
  activationId: value.activationId,
  attemptId: value.attemptId,
  attemptPhase: value.attemptPhase,
  dispatchIdempotencyKey: value.dispatchIdempotencyKey,
  executorConfigurationDigest: value.executorConfigurationDigest,
  executorContractPin: {
    adapterId: value.executorContractPin.adapterId,
    digest: value.executorContractPin.digest,
    revision: value.executorContractPin.revision,
  },
  expectedAttemptRevision: value.expectedAttemptRevision,
  expectedNodeRevision: value.expectedNodeRevision,
  expectedRunRevision: value.expectedRunRevision,
  fencingToken: value.fencingToken,
  leaseExpiresAt: value.leaseExpiresAt,
  managerIncarnationId: value.managerIncarnationId,
  nodeInstanceId: value.nodeInstanceId,
  nodeKey: value.nodeKey,
  nodePhase: value.nodePhase,
  planPin: {
    digest: value.planPin.digest,
    id: value.planPin.id,
    revision: value.planPin.revision,
  },
  runId: value.runId,
});

const textMember = (record: Readonly<Record<string, JsonValue>>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string') throw new TypeError('Store idempotency result is invalid.');
  return value;
};

const numberMember = (record: Readonly<Record<string, JsonValue>>, key: string): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('Store idempotency result is invalid.');
  }
  return value;
};

const sameSemanticJson = (left: unknown, right: JsonValue): boolean =>
  canonicalizeJson(snapshotPortableJsonValue(left)) === canonicalizeJson(right);

const sameSemanticRecordRequest = (record: unknown, expected: JsonValue): boolean => {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('Store idempotency record is invalid.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, 'request');
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError('Store idempotency request is invalid.');
  }
  return sameSemanticJson(descriptor.value, expected);
};

const mapNonCommit = (result: Exclude<RunStoreCommitResult, { readonly kind: 'committed' }>) => {
  if (result.kind === 'conflict') return conflict(result.conflict);
  if (result.kind === 'invalid_input') return invalid();
  throw new TypeError('Unexpected idempotency replay.');
};

const mapDomainError = (error: unknown) => {
  if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
  if (error.message === 'REVISION_CONFLICT') {
    return conflict({
      code: 'REVISION_CONFLICT',
      message: 'Lifecycle authority revision is stale.',
    });
  }
  if (error.message === 'STALE_FENCE') {
    return conflict({ code: 'STALE_FENCE', message: 'Lifecycle authority fence is stale.' });
  }
  if (error.message === 'INVALID_STATE') {
    return conflict({ code: 'INVALID_STATE', message: 'Lifecycle state is incompatible.' });
  }
  return invalid();
};

const mapHandoff = (
  result: RunStoreCommitResult,
  receipt: LifecycleHandoffReceipt,
  identity: RunStoreIdempotencyIdentity,
): LifecycleWriteHandoffResult => {
  if (result.kind === 'committed') {
    return Object.freeze({
      cursor: mapCursor(result.cursor),
      kind: 'committed',
      transactionNow: result.transactionNow,
      value: receipt,
    });
  }
  if (result.kind === 'replayed') {
    validateReplayRecord(result.record, identity);
    const value = recordValue(result.record, ['attemptId', 'handoffId', 'incumbentFencingToken']);
    const replayReceipt = Object.freeze({
      attemptId: textMember(value, 'attemptId'),
      handoffId: textMember(value, 'handoffId'),
      incumbentFencingToken: numberMember(value, 'incumbentFencingToken'),
    });
    if (
      replayReceipt.attemptId !== receipt.attemptId ||
      replayReceipt.handoffId !== receipt.handoffId ||
      replayReceipt.incumbentFencingToken !== receipt.incumbentFencingToken
    ) {
      throw new TypeError('Store idempotency result is invalid.');
    }
    return Object.freeze({
      committedAt: result.record.committedAt,
      cursor: mapCursor(result.record.cursor),
      kind: 'replayed',
      value: replayReceipt,
    });
  }
  return mapNonCommit(result);
};

const mapAcquireReplay = (
  record: RunStoreIdempotencyRecord,
  identity: RunStoreIdempotencyIdentity,
  expected: LifecycleAcquireReplayReceipt,
): LifecycleAcquireResult => {
  validateReplayRecord(record, identity);
  const value = recordValue(record, [
    'attemptId',
    'attemptPhase',
    'nodeInstanceId',
    'nodePhase',
    'recovery',
    'runId',
    'successorFencingToken',
    'successorManagerIncarnationId',
  ]);
  const recovery = textMember(value, 'recovery');
  if (recovery !== 'start' && recovery !== 'reconcile') {
    throw new TypeError('Store idempotency result is invalid.');
  }
  const replayAttemptPhase = textMember(value, 'attemptPhase');
  const replayNodePhase = textMember(value, 'nodePhase');
  if (
    (replayAttemptPhase !== 'claimed' && replayAttemptPhase !== 'unknown') ||
    (replayNodePhase !== 'executing' && replayNodePhase !== 'unknown') ||
    (recovery === 'start' &&
      (replayAttemptPhase !== 'claimed' || replayNodePhase !== 'executing')) ||
    (recovery === 'reconcile' &&
      (replayAttemptPhase !== 'unknown' || replayNodePhase !== 'unknown'))
  ) {
    throw new TypeError('Store idempotency result is invalid.');
  }
  const receipt: LifecycleAcquireReplayReceipt = Object.freeze({
    attemptId: textMember(value, 'attemptId'),
    nodeInstanceId: textMember(value, 'nodeInstanceId'),
    recovery,
    runId: textMember(value, 'runId'),
    successorFencingToken: numberMember(value, 'successorFencingToken'),
    successorManagerIncarnationId: textMember(value, 'successorManagerIncarnationId'),
  });
  if (
    receipt.attemptId !== expected.attemptId ||
    receipt.nodeInstanceId !== expected.nodeInstanceId ||
    receipt.recovery !== expected.recovery ||
    receipt.runId !== expected.runId ||
    receipt.successorFencingToken !== expected.successorFencingToken ||
    receipt.successorManagerIncarnationId !== expected.successorManagerIncarnationId
  ) {
    throw new TypeError('Store idempotency result is invalid.');
  }
  return Object.freeze({
    committedAt: record.committedAt,
    cursor: mapCursor(record.cursor),
    kind: 'replayed',
    value: receipt,
  });
};

export const lifecycleSupport = Object.freeze({
  fault,
  invalid,
  notFound,
  conflict,
  boundedString,
  safeAdd,
  samePin,
  mapCursor,
  validateReplayRecord,
  mapDiscoveryCursor,
  mapCandidate,
  authority,
  expectation,
  incumbentAuthority,
  loadAuthority,
  isJsonRecord,
  recordValue,
  authorityMatches,
  authorityJson,
  textMember,
  numberMember,
  sameSemanticJson,
  sameSemanticRecordRequest,
  mapNonCommit,
  mapDomainError,
  mapHandoff,
  mapAcquireReplay,
});
