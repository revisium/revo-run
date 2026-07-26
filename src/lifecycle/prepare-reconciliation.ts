import { applyDomainOperation } from '../domain/index.js';
import {
  snapshotExecutorInvocationSnapshot,
  snapshotPortableJsonValue,
  verifyExecutorBinding,
} from '../policy/index.js';
import type { ExecutorResolver } from '../ports/index.js';
import type { ExecutorInvocationSnapshot, JsonValue } from '../spec/index.js';
import type {
  RunStore,
  RunStoreIdempotencyIdentity,
  RunStoreTransaction,
} from '../storage/index.js';
import { resolveExactExecutorCapabilities } from './exact-executor-capabilities.js';
import { checkLifecycleAuthority } from './lifecycle-authority-check.js';
import { lifecycleObservationReplay } from './lifecycle-observation-replay.js';
import { lifecycleObservationValidation } from './lifecycle-observation-validation.js';
import type { LifecyclePrepareReconciliationRequest } from './lifecycle-prepare-reconciliation-request.js';
import type { LifecyclePrepareReconciliationResult } from './lifecycle-prepare-reconciliation-result.js';
import type { LifecyclePreparedReconcileCapability } from './lifecycle-prepared-reconcile-capability.js';
import type { LifecycleReconciliationReplayReceipt } from './lifecycle-reconciliation-replay-receipt.js';
import { lifecycleSupport } from './lifecycle-support.js';
import { executorObservationNormalization } from './normalize-executor-observation.js';

const {
  authority,
  expectation,
  fault,
  incumbentAuthority,
  invalid,
  mapCursor,
  mapDomainError,
  mapNonCommit,
  safeAdd,
  samePin,
} = lifecycleSupport;

const identity = (request: LifecyclePrepareReconciliationRequest): RunStoreIdempotencyIdentity => ({
  key: request.beginIdempotencyKey,
  operation: 'begin_reconciliation',
  runId: request.authority.runId,
  subjectId: request.authority.attemptId,
});

const expectedReceipt = (
  request: LifecyclePrepareReconciliationRequest,
): LifecycleReconciliationReplayReceipt =>
  Object.freeze({
    attemptId: request.authority.attemptId,
    attemptPhase: 'reconciling',
    attemptRevision: safeAdd(request.authority.expectedAttemptRevision, 1),
    fencingToken: request.authority.fencingToken,
    managerIncarnationId: request.authority.managerIncarnationId,
    nodeInstanceId: request.authority.nodeInstanceId,
    nodePhase: 'unknown',
    runId: request.authority.runId,
  });

const parseReceipt = (value: JsonValue): LifecycleReconciliationReplayReceipt => {
  const source = lifecycleObservationReplay.exactRecord(value, [
    'attemptId',
    'attemptPhase',
    'attemptRevision',
    'fencingToken',
    'managerIncarnationId',
    'nodeInstanceId',
    'nodePhase',
    'runId',
  ]);
  if (source['attemptPhase'] !== 'reconciling' || source['nodePhase'] !== 'unknown') {
    throw new TypeError('Reconciliation replay is invalid.');
  }
  return Object.freeze({
    attemptId: lifecycleObservationReplay.text(source['attemptId']),
    attemptPhase: 'reconciling',
    attemptRevision: lifecycleObservationReplay.integer(source['attemptRevision']),
    fencingToken: lifecycleObservationReplay.integer(source['fencingToken']),
    managerIncarnationId: lifecycleObservationReplay.text(source['managerIncarnationId']),
    nodeInstanceId: lifecycleObservationReplay.text(source['nodeInstanceId']),
    nodePhase: 'unknown',
    runId: lifecycleObservationReplay.text(source['runId']),
  });
};

const semanticRequest = (
  request: LifecyclePrepareReconciliationRequest,
  binding: LifecyclePrepareReconciliationRequest['planDocument']['executorBindings'][number],
): JsonValue =>
  snapshotPortableJsonValue({
    authority: request.authority,
    binding: {
      executorConfiguration: binding.configuration,
      executorConfigurationDigest: binding.configurationDigest,
      executorContractPin: binding.executor,
      idempotentExecution: binding.idempotentExecution,
      nodeKey: binding.nodeKey,
    },
    version: 1,
  });

const findBinding = (request: LifecyclePrepareReconciliationRequest) => {
  const bindings = request.planDocument.executorBindings.filter(
    ({ nodeKey }) => nodeKey === request.authority.nodeKey,
  );
  return bindings.length === 1 ? bindings[0] : undefined;
};

const lookupReplay = async (
  transaction: RunStoreTransaction,
  replayIdentity: RunStoreIdempotencyIdentity,
  requestValue: JsonValue,
  receipt: LifecycleReconciliationReplayReceipt,
): Promise<LifecyclePrepareReconciliationResult | null> => {
  const result = await transaction.getIdempotency(replayIdentity);
  if (result.kind === 'invalid_input') return invalid();
  return result.kind === 'found'
    ? lifecycleObservationReplay.map(
        result.value,
        replayIdentity,
        requestValue,
        { ...receipt },
        parseReceipt,
      )
    : null;
};

const snapshotInvocation = (
  loaded: Exclude<
    Awaited<ReturnType<typeof checkLifecycleAuthority>>,
    { readonly result: LifecyclePrepareReconciliationResult }
  >,
  verified: Extract<ReturnType<typeof verifyExecutorBinding>, { readonly kind: 'verified' }>,
): ExecutorInvocationSnapshot =>
  snapshotExecutorInvocationSnapshot({
    activationContext: loaded.node.activationContext,
    attempt: {
      activationId: loaded.node.activationId,
      attemptId: loaded.attempt.id,
      dispatchIdempotencyKey: loaded.attempt.dispatchIdempotencyKey,
      nodeInstanceId: loaded.node.id,
      nodeKey: loaded.node.nodeKey,
      runId: loaded.run.id,
    },
    executorConfiguration: verified.evidence.executorConfiguration,
    executorConfigurationDigest: verified.evidence.executorConfigurationDigest,
    executorContractPin: verified.evidence.executorContractPin,
    runInput: loaded.run.input,
  });

const createCapability = (
  resolution: Awaited<ReturnType<typeof resolveExactExecutorCapabilities>>,
  invocation: ExecutorInvocationSnapshot,
): LifecyclePreparedReconcileCapability => {
  let consumed = false;
  const invoke = Object.freeze(async (signal: AbortSignal) => {
    if (consumed) throw new TypeError('Prepared reconcile capability was already consumed.');
    consumed = true;
    const reconcile = resolution.reconcile;
    if (reconcile === null) {
      throw new TypeError('Prepared reconcile capability is unavailable.');
    }
    return executorObservationNormalization.invokeReconcile(() => {
      const result: unknown = Reflect.apply(reconcile, resolution.executor, [
        Object.freeze({ invocation, operation: 'reconcile', signal }),
      ]);
      return Promise.resolve(result);
    });
  });
  return Object.freeze({ invoke });
};

const commitBegin = (
  store: RunStore,
  request: LifecyclePrepareReconciliationRequest,
  replayIdentity: RunStoreIdempotencyIdentity,
  requestValue: JsonValue,
  receipt: LifecycleReconciliationReplayReceipt,
  resolution: Awaited<ReturnType<typeof resolveExactExecutorCapabilities>>,
  verified: Extract<ReturnType<typeof verifyExecutorBinding>, { readonly kind: 'verified' }>,
): Promise<LifecyclePrepareReconciliationResult> =>
  store.transaction(async (transaction) => {
    const replay = await lookupReplay(transaction, replayIdentity, requestValue, receipt);
    if (replay !== null) return replay;
    const loaded = await checkLifecycleAuthority(transaction, request.authority, {
      attempt: 'unknown',
      node: 'unknown',
    });
    if ('result' in loaded) return loaded.result;
    let invocation;
    let transition;
    try {
      invocation = snapshotInvocation(loaded, verified);
      transition = applyDomainOperation({
        attempt: loaded.attempt,
        authority: {
          ...incumbentAuthority(request.authority),
          transactionNow: transaction.transactionNow,
        },
        kind: 'begin_reconciliation',
        node: loaded.node,
        run: loaded.run,
      });
    } catch (error) {
      return mapDomainError(error);
    }
    const nextAttempt = transition.attempts[0];
    const nextNode = transition.nodes[0];
    if (nextAttempt === undefined || nextNode === undefined) return invalid();
    const reconcilerAuthority = authority(transition.run, nextNode, nextAttempt);
    if (
      reconcilerAuthority.attemptPhase !== 'reconciling' ||
      reconcilerAuthority.nodePhase !== 'unknown'
    ) {
      return invalid();
    }
    const prepared = Object.freeze({
      authority: Object.freeze({
        ...reconcilerAuthority,
        attemptPhase: 'reconciling' as const,
        nodePhase: 'unknown' as const,
      }),
      invocation,
      kind: 'reconcile' as const,
      reconcile: createCapability(resolution, invocation),
    });
    const expected = expectation(loaded.run, loaded.node, loaded.attempt);
    const result = await transaction.commit({
      authority: incumbentAuthority(request.authority),
      expected: {
        absentAttemptIds: [],
        absentNodes: [],
        absentOutputIds: [],
        attempts: [expected.attempt],
        nodes: [expected.node],
        run: expected.run,
      },
      idempotency: {
        identity: replayIdentity,
        request: requestValue,
        result: { ...receipt },
      },
      kind: 'apply_incumbent_transition',
      operation: 'begin_reconciliation',
      transition,
    });
    if (result.kind === 'replayed') {
      return lifecycleObservationReplay.map(
        result.record,
        replayIdentity,
        requestValue,
        { ...receipt },
        parseReceipt,
      );
    }
    if (result.kind !== 'committed') return mapNonCommit(result);
    return Object.freeze({
      cursor: mapCursor(result.cursor),
      kind: 'committed',
      transactionNow: result.transactionNow,
      value: prepared,
    });
  });

export const prepareReconciliation = async (
  store: RunStore,
  executors: ExecutorResolver,
  input: LifecyclePrepareReconciliationRequest,
): Promise<LifecyclePrepareReconciliationResult> => {
  let request;
  let binding;
  let replayIdentity;
  let requestValue;
  let receipt;
  try {
    request = lifecycleObservationValidation.prepareRequest(input);
    if (!samePin(request.planDocument.pin, request.authority.planPin)) {
      return fault('PLAN_MISMATCH', 'Execution plan pin does not match reconciliation authority.');
    }
    binding = findBinding(request);
    if (binding === undefined) {
      return fault('PLAN_MISMATCH', 'Execution plan has no exact reconciliation binding.');
    }
    replayIdentity = identity(request);
    requestValue = semanticRequest(request, binding);
    receipt = expectedReceipt(request);
  } catch {
    return invalid();
  }
  const initial = await store.transaction(async (transaction) => {
    const replay = await lookupReplay(transaction, replayIdentity, requestValue, receipt);
    if (replay !== null) return { result: replay } as const;
    return checkLifecycleAuthority(transaction, request.authority, {
      attempt: 'unknown',
      node: 'unknown',
    });
  });
  if ('result' in initial) return initial.result;
  let resolution;
  let verified;
  try {
    resolution = await resolveExactExecutorCapabilities(
      executors,
      initial.attempt.executorContractPin,
    );
    verified = verifyExecutorBinding({
      attempt: {
        executorConfigurationDigest: initial.attempt.executorConfigurationDigest,
        executorContractPin: initial.attempt.executorContractPin,
      },
      binding: {
        configuration: binding.configuration,
        configurationDigest: binding.configurationDigest,
        executor: binding.executor,
        idempotentExecution: binding.idempotentExecution,
      },
      resolvedExecutorContractPin: resolution.contractPin,
    });
  } catch {
    return fault('EXECUTOR_UNAVAILABLE', 'Exact executor is unavailable.');
  }
  if (verified.kind === 'mismatch') {
    return fault('EXECUTOR_MISMATCH', 'Exact executor binding does not match the Attempt.');
  }
  if (resolution.reconcile === null) {
    return fault('UNKNOWN_OUTCOME', 'Exact executor does not support reconciliation.');
  }
  return commitBegin(store, request, replayIdentity, requestValue, receipt, resolution, verified);
};
