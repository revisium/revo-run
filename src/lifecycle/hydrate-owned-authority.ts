import { snapshotPortableJsonValue } from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type { RunStore, RunStoreTransaction } from '../storage/index.js';
import type { LifecycleActiveAttemptPhase } from './lifecycle-active-attempt-phase.js';
import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleHydrateOwnedAuthorityRequest } from './lifecycle-hydrate-owned-authority-request.js';
import type { LifecycleHydrateOwnedAuthorityResult } from './lifecycle-hydrate-owned-authority-result.js';
import { lifecycleSupport } from './lifecycle-support.js';
import { lifecycleValidation } from './lifecycle-validation.js';

type JsonRecord = { readonly [key: string]: JsonValue };

type LookupSnapshot =
  | { readonly kind: 'found'; readonly value: JsonRecord }
  | { readonly kind: 'invalid_input' }
  | { readonly kind: 'not_found' };

type BoundaryResult<Value> =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly value: Value };

interface PreparedHydration {
  readonly attempt: JsonRecord;
  readonly attemptPhase: LifecycleActiveAttemptPhase;
  readonly fencingToken: number;
  readonly managerIncarnationId: string;
  readonly node: JsonRecord;
  readonly nodePhase: 'executing' | 'unknown';
  readonly run: JsonRecord;
}

const { conflict, invalid, notFound } = lifecycleSupport;

const atBoundary = <Value>(operation: () => Value): BoundaryResult<Value> => {
  try {
    return Object.freeze({ kind: 'valid', value: operation() });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return Object.freeze({ kind: 'invalid' });
    }
    throw error;
  }
};

const isJsonRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const jsonRecord = (value: JsonValue | undefined): JsonRecord => {
  if (value === undefined || !isJsonRecord(value)) throw new TypeError('INVALID_INPUT');
  return value;
};

const textMember = (record: JsonRecord, key: string): string => {
  const value = record[key];
  return lifecycleValidation.boundedText(value);
};

const textMemberEquals = (record: JsonRecord, key: string, expected: string): boolean => {
  const value = record[key];
  return typeof value === 'string' && lifecycleValidation.boundedText(value) === expected;
};

const numberMember = (record: JsonRecord, key: string): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('INVALID_INPUT');
  }
  return value;
};

const lookupSnapshot = (value: unknown): LookupSnapshot => {
  const source = jsonRecord(snapshotPortableJsonValue(value));
  const kind = textMember(source, 'kind');
  if (kind === 'not_found') return Object.freeze({ kind });
  if (kind === 'invalid_input') return Object.freeze({ kind });
  if (kind !== 'found') throw new TypeError('INVALID_INPUT');
  return Object.freeze({ kind, value: jsonRecord(source['value']) });
};

const transactionNow = (transaction: RunStoreTransaction): number => {
  const descriptor = Object.getOwnPropertyDescriptor(transaction, 'transactionNow');
  if (!descriptor || !('value' in descriptor)) throw new TypeError('INVALID_INPUT');
  const value = snapshotPortableJsonValue(descriptor.value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('INVALID_INPUT');
  }
  return value;
};

const expectedNodePhase = (phase: LifecycleActiveAttemptPhase): 'executing' | 'unknown' =>
  phase === 'claimed' || phase === 'start_committed' ? 'executing' : 'unknown';

const recoveryFor = (phase: LifecycleActiveAttemptPhase): 'reconcile' | 'start' =>
  phase === 'claimed' ? 'start' : 'reconcile';

const correlationsMatch = (
  request: LifecycleHydrateOwnedAuthorityRequest,
  run: JsonRecord,
  node: JsonRecord,
  attempt: JsonRecord,
): boolean => {
  const runId = textMember(run, 'id');
  const nodeId = textMember(node, 'id');
  const attemptId = textMember(attempt, 'id');
  return (
    runId === request.runId &&
    nodeId === request.nodeInstanceId &&
    textMember(node, 'runId') === runId &&
    attemptId === request.attemptId &&
    textMember(attempt, 'runId') === runId &&
    textMember(attempt, 'nodeInstanceId') === nodeId &&
    textMemberEquals(node, 'activeAttemptId', attemptId)
  );
};

const phaseMatches = (
  request: LifecycleHydrateOwnedAuthorityRequest,
  run: JsonRecord,
  node: JsonRecord,
  attempt: JsonRecord,
): boolean => {
  const runStatus = textMember(run, 'status');
  return (
    textMember(attempt, 'status') === request.expectedPhase &&
    textMember(node, 'status') === expectedNodePhase(request.expectedPhase) &&
    (runStatus === 'running' || runStatus === 'cancelling')
  );
};

const incumbentMatches = (
  request: LifecycleHydrateOwnedAuthorityRequest,
  attempt: JsonRecord,
): boolean =>
  textMember(attempt, 'managerIncarnationId') === request.expectedManagerIncarnationId &&
  numberMember(attempt, 'fencingToken') === request.expectedAttemptFence;

const prepareHydration = (
  request: LifecycleHydrateOwnedAuthorityRequest,
  run: JsonRecord,
  node: JsonRecord,
  attempt: JsonRecord,
): LifecycleConflictResult | { readonly kind: 'prepared'; readonly value: PreparedHydration } => {
  if (!correlationsMatch(request, run, node, attempt)) {
    return conflict({ code: 'STALE_FENCE', message: 'Hydration authority is stale.' });
  }

  const managerIncarnationId = textMember(attempt, 'managerIncarnationId');
  const fencingToken = numberMember(attempt, 'fencingToken');
  if (!incumbentMatches(request, attempt)) {
    return conflict({ code: 'STALE_FENCE', message: 'Hydration authority is stale.' });
  }

  return Object.freeze({
    kind: 'prepared',
    value: Object.freeze({
      attempt,
      attemptPhase: request.expectedPhase,
      fencingToken,
      managerIncarnationId,
      node,
      nodePhase: expectedNodePhase(request.expectedPhase),
      run,
    }),
  });
};

const finalizeHydration = (
  transaction: RunStoreTransaction,
  request: LifecycleHydrateOwnedAuthorityRequest,
  prepared: PreparedHydration,
): LifecycleHydrateOwnedAuthorityResult => {
  const now = transactionNow(transaction);
  const leaseExpiresAt = numberMember(prepared.attempt, 'leaseExpiresAt');
  if (now >= leaseExpiresAt) {
    return conflict({ code: 'STALE_FENCE', message: 'Hydration lease is stale.' });
  }

  const authority = lifecycleValidation.authority({
    activationId: prepared.node['activationId'],
    attemptId: request.attemptId,
    attemptPhase: prepared.attemptPhase,
    dispatchIdempotencyKey: prepared.attempt['dispatchIdempotencyKey'],
    executorConfigurationDigest: prepared.attempt['executorConfigurationDigest'],
    executorContractPin: prepared.attempt['executorContractPin'],
    expectedAttemptRevision: prepared.attempt['revision'],
    expectedNodeRevision: prepared.node['revision'],
    expectedRunRevision: prepared.run['revision'],
    fencingToken: prepared.fencingToken,
    leaseExpiresAt,
    managerIncarnationId: prepared.managerIncarnationId,
    nodeInstanceId: request.nodeInstanceId,
    nodeKey: prepared.node['nodeKey'],
    nodePhase: prepared.nodePhase,
    planPin: prepared.run['planPin'],
    runId: request.runId,
  });
  const value = Object.freeze({
    authority,
    phase: request.expectedPhase,
    recovery: recoveryFor(request.expectedPhase),
  });
  return Object.freeze({ kind: 'hydrated', transactionNow: now, value });
};

const hydrateInTransaction = async (
  transaction: RunStoreTransaction,
  request: LifecycleHydrateOwnedAuthorityRequest,
): Promise<LifecycleHydrateOwnedAuthorityResult> => {
  const [run, node, attempt] = await Promise.all([
    transaction.getRun(request.runId),
    transaction.getNode(request.nodeInstanceId),
    transaction.getAttempt(request.attemptId),
  ]);
  const snapshots = atBoundary(() => [run, node, attempt].map((value) => lookupSnapshot(value)));
  if (snapshots.kind === 'invalid') return invalid();
  const [runSnapshot, nodeSnapshot, attemptSnapshot] = snapshots.value;
  if (
    runSnapshot?.kind === 'invalid_input' ||
    nodeSnapshot?.kind === 'invalid_input' ||
    attemptSnapshot?.kind === 'invalid_input'
  ) {
    return invalid();
  }
  if (
    runSnapshot?.kind !== 'found' ||
    nodeSnapshot?.kind !== 'found' ||
    attemptSnapshot?.kind !== 'found'
  ) {
    return notFound();
  }
  const prepared = atBoundary(() =>
    prepareHydration(request, runSnapshot.value, nodeSnapshot.value, attemptSnapshot.value),
  );
  if (prepared.kind === 'invalid') return invalid();
  const preparedResult = prepared.value;
  if (preparedResult.kind !== 'prepared') return preparedResult;
  const preparedHydration = preparedResult.value;

  const handoffResult = await transaction.getHandoff({
    attemptId: request.attemptId,
    incumbentFencingToken: preparedHydration.fencingToken,
  });
  const handoff = atBoundary(() => lookupSnapshot(handoffResult));
  if (handoff.kind === 'invalid' || handoff.value.kind === 'invalid_input') return invalid();
  if (handoff.value.kind === 'found') {
    return conflict({ code: 'STALE_FENCE', message: 'Hydration authority was handed off.' });
  }

  const compatiblePhase = atBoundary(() =>
    phaseMatches(request, preparedHydration.run, preparedHydration.node, preparedHydration.attempt),
  );
  if (compatiblePhase.kind === 'invalid') return invalid();
  if (!compatiblePhase.value) {
    return conflict({ code: 'INVALID_STATE', message: 'Hydration state is incompatible.' });
  }

  const finalized = atBoundary(() => finalizeHydration(transaction, request, preparedHydration));
  return finalized.kind === 'valid' ? finalized.value : invalid();
};

export const hydrateOwnedAuthority = async (
  store: RunStore,
  request: LifecycleHydrateOwnedAuthorityRequest,
): Promise<LifecycleHydrateOwnedAuthorityResult> => {
  const stableRequest = atBoundary(() => lifecycleValidation.hydrateOwnedAuthorityRequest(request));
  if (stableRequest.kind === 'invalid') return invalid();
  return store.transaction((transaction) => hydrateInTransaction(transaction, stableRequest.value));
};
