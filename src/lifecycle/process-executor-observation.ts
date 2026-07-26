import { applyDomainOperation } from '../domain/index.js';
import { canonicalizeJson, snapshotPortableJsonValue } from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type {
  RunStore,
  RunStoreIdempotencyIdentity,
  RunStoreTransaction,
} from '../storage/index.js';
import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';
import { checkLifecycleAuthority } from './lifecycle-authority-check.js';
import type { LifecycleObservationReceipt } from './lifecycle-observation-receipt.js';
import { lifecycleObservationReplay } from './lifecycle-observation-replay.js';
import { lifecycleObservationValidation } from './lifecycle-observation-validation.js';
import type { LifecycleProcessExecuteObservationRequest } from './lifecycle-process-execute-observation-request.js';
import type { LifecycleProcessObservationResult } from './lifecycle-process-observation-result.js';
import type { LifecycleProcessReconcileObservationRequest } from './lifecycle-process-reconcile-observation-request.js';
import type { LifecycleProgressionObservation } from './lifecycle-progression-observation.js';
import { lifecycleSupport } from './lifecycle-support.js';
import { lifecycleValidation } from './lifecycle-validation.js';

type ProcessRequest =
  | LifecycleProcessExecuteObservationRequest
  | LifecycleProcessReconcileObservationRequest;

type DurableObservation = 'running' | 'unknown';
type DurableOperation = 'direct_unknown' | 'reconciled_running' | 'reconciled_unknown';

const {
  authority,
  authorityJson,
  expectation,
  incumbentAuthority,
  invalid,
  mapCursor,
  mapDomainError,
  mapNonCommit,
  safeAdd,
} = lifecycleSupport;

const operationFor = (
  request: ProcessRequest,
): { readonly observation: DurableObservation; readonly operation: DurableOperation } | null => {
  if (request.observation.kind === 'unknown') {
    return {
      observation: 'unknown',
      operation:
        request.authority.attemptPhase === 'start_committed'
          ? 'direct_unknown'
          : 'reconciled_unknown',
    };
  }
  return request.observation.kind === 'running'
    ? { observation: 'running', operation: 'reconciled_running' }
    : null;
};

const identity = (
  request: ProcessRequest,
  operation: DurableOperation,
): RunStoreIdempotencyIdentity => ({
  key: request.idempotencyKey,
  operation,
  runId: request.authority.runId,
  subjectId: request.authority.attemptId,
});

const nextAuthority = (
  source: LifecycleAttemptAuthority,
  operation: DurableOperation,
): LifecycleObservationReceipt['authority'] => {
  const attemptRevision = safeAdd(source.expectedAttemptRevision, 1);
  if (operation === 'reconciled_unknown') {
    return Object.freeze({
      ...source,
      attemptPhase: 'unknown',
      expectedAttemptRevision: attemptRevision,
      nodePhase: 'unknown',
    });
  }
  const common = {
    ...source,
    expectedAttemptRevision: attemptRevision,
    expectedNodeRevision: safeAdd(source.expectedNodeRevision, 1),
    expectedRunRevision: safeAdd(source.expectedRunRevision, 1),
  };
  return operation === 'reconciled_running'
    ? Object.freeze({
        ...common,
        attemptPhase: 'start_committed',
        nodePhase: 'executing',
      })
    : Object.freeze({
        ...common,
        attemptPhase: 'unknown',
        nodePhase: 'unknown',
      });
};

const receipt = (
  request: ProcessRequest,
  operation: DurableOperation,
  observation: DurableObservation,
): LifecycleObservationReceipt =>
  Object.freeze({ authority: nextAuthority(request.authority, operation), observation });

const receiptJson = (value: LifecycleObservationReceipt): JsonValue =>
  snapshotPortableJsonValue({
    authority: authorityJson(value.authority),
    observation: value.observation,
  });

const parseReceipt = (
  value: JsonValue,
  expectedObservation: DurableObservation,
): LifecycleObservationReceipt => {
  const source = lifecycleObservationReplay.exactRecord(value, ['authority', 'observation']);
  if (source['observation'] !== expectedObservation) {
    throw new TypeError('Observation replay is invalid.');
  }
  const parsed = lifecycleValidation.authority(source['authority']);
  if (
    expectedObservation === 'running' &&
    (parsed.attemptPhase !== 'start_committed' || parsed.nodePhase !== 'executing')
  ) {
    throw new TypeError('Observation replay is invalid.');
  }
  if (
    expectedObservation === 'unknown' &&
    (parsed.attemptPhase !== 'unknown' || parsed.nodePhase !== 'unknown')
  ) {
    throw new TypeError('Observation replay is invalid.');
  }
  return Object.freeze({
    authority:
      expectedObservation === 'running'
        ? Object.freeze({
            ...parsed,
            attemptPhase: 'start_committed',
            nodePhase: 'executing',
          })
        : Object.freeze({ ...parsed, attemptPhase: 'unknown', nodePhase: 'unknown' }),
    observation: expectedObservation,
  });
};

const semanticRequest = (request: ProcessRequest): JsonValue =>
  snapshotPortableJsonValue({
    authority: authorityJson(request.authority),
    generatedOutputIds: request.generatedOutputIds,
    observation: request.observation,
    version: 1,
  });

const outputShapeIsValid = (request: ProcessRequest): boolean =>
  request.observation.kind === 'succeeded'
    ? request.observation.outputs.length === request.generatedOutputIds.length
    : request.generatedOutputIds.length === 0;

const progressionObservation = (request: ProcessRequest): LifecycleProgressionObservation => {
  const observation = request.observation;
  if (observation.kind === 'cancelled') return Object.freeze({ kind: 'cancelled' });
  if (observation.kind === 'failed') {
    return Object.freeze({
      fault: Object.freeze({ ...observation.fault }),
      kind: 'failed',
    });
  }
  if (observation.kind !== 'succeeded') {
    throw new TypeError('Observation does not require progression.');
  }
  const outputs = observation.outputs.map((output, index) =>
    Object.freeze({
      name: output.name,
      outputId: request.generatedOutputIds[index] ?? '',
      payload: output.payload,
    }),
  );
  return Object.freeze({ kind: 'succeeded', outputs: Object.freeze(outputs) });
};

const freshAuthority = (transaction: RunStoreTransaction, request: ProcessRequest) =>
  checkLifecycleAuthority(
    transaction,
    request.authority,
    request.authority.attemptPhase === 'start_committed'
      ? { attempt: 'start_committed', node: 'executing' }
      : { attempt: 'reconciling', node: 'unknown' },
  );

const requireProgression = (
  store: RunStore,
  request: ProcessRequest,
): Promise<LifecycleProcessObservationResult> =>
  store.transaction(async (transaction) => {
    const loaded = await freshAuthority(transaction, request);
    if ('result' in loaded) return loaded.result;
    return Object.freeze({
      authority: Object.freeze({ ...request.authority }),
      kind: 'requires_progression',
      observation: progressionObservation(request),
    });
  });

const lookupReplay = async (
  transaction: RunStoreTransaction,
  replayIdentity: RunStoreIdempotencyIdentity,
  requestValue: JsonValue,
  expectedReceipt: LifecycleObservationReceipt,
): Promise<LifecycleProcessObservationResult | null> => {
  const result = await transaction.getIdempotency(replayIdentity);
  if (result.kind === 'invalid_input') return invalid();
  const resultValue = receiptJson(expectedReceipt);
  return result.kind === 'found'
    ? lifecycleObservationReplay.map(
        result.value,
        replayIdentity,
        requestValue,
        resultValue,
        (value) => parseReceipt(value, expectedReceipt.observation),
      )
    : null;
};

const transitionFor = (
  request: ProcessRequest,
  loaded: Exclude<
    Awaited<ReturnType<typeof freshAuthority>>,
    { readonly result: LifecycleProcessObservationResult }
  >,
  transactionNow: number,
  operation: DurableOperation,
) => {
  const base = {
    attempt: loaded.attempt,
    authority: { ...incumbentAuthority(request.authority), transactionNow },
    node: loaded.node,
    run: loaded.run,
  };
  if (operation === 'direct_unknown') {
    const observation = request.observation;
    if (observation.kind !== 'unknown') throw new TypeError('INVALID_INPUT');
    return applyDomainOperation({ ...base, fault: observation.fault, kind: operation });
  }
  return applyDomainOperation({ ...base, kind: operation });
};

const commitDurableObservation = (
  store: RunStore,
  request: ProcessRequest,
  operation: DurableOperation,
  observation: DurableObservation,
): Promise<LifecycleProcessObservationResult> => {
  const replayIdentity = identity(request, operation);
  const requestValue = semanticRequest(request);
  const expectedReceipt = receipt(request, operation, observation);
  const resultValue = receiptJson(expectedReceipt);
  return store.transaction(async (transaction) => {
    const replay = await lookupReplay(transaction, replayIdentity, requestValue, expectedReceipt);
    if (replay !== null) return replay;
    const loaded = await freshAuthority(transaction, request);
    if ('result' in loaded) return loaded.result;
    let transition;
    try {
      transition = transitionFor(request, loaded, transaction.transactionNow, operation);
    } catch (error) {
      return mapDomainError(error);
    }
    const nextAttempt = transition.attempts[0];
    const nextNode = transition.nodes[0];
    if (nextAttempt === undefined || nextNode === undefined) return invalid();
    const actualAuthority = authority(transition.run, nextNode, nextAttempt);
    if (
      (observation === 'running' &&
        (actualAuthority.attemptPhase !== 'start_committed' ||
          actualAuthority.nodePhase !== 'executing')) ||
      (observation === 'unknown' &&
        (actualAuthority.attemptPhase !== 'unknown' || actualAuthority.nodePhase !== 'unknown'))
    ) {
      return invalid();
    }
    const actualReceipt: LifecycleObservationReceipt = Object.freeze({
      authority:
        observation === 'running'
          ? Object.freeze({
              ...actualAuthority,
              attemptPhase: 'start_committed',
              nodePhase: 'executing',
            })
          : Object.freeze({
              ...actualAuthority,
              attemptPhase: 'unknown',
              nodePhase: 'unknown',
            }),
      observation,
    });
    if (canonicalizeJson(receiptJson(actualReceipt)) !== canonicalizeJson(resultValue)) {
      return invalid();
    }
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
        result: resultValue,
      },
      kind: 'apply_incumbent_transition',
      operation,
      transition,
    });
    if (result.kind === 'replayed') {
      return lifecycleObservationReplay.map(
        result.record,
        replayIdentity,
        requestValue,
        resultValue,
        (value) => parseReceipt(value, observation),
      );
    }
    if (result.kind !== 'committed') return mapNonCommit(result);
    return Object.freeze({
      cursor: mapCursor(result.cursor),
      kind: 'committed',
      transactionNow: result.transactionNow,
      value: expectedReceipt,
    });
  });
};

const process = (
  store: RunStore,
  request: ProcessRequest,
): Promise<LifecycleProcessObservationResult> => {
  if (!outputShapeIsValid(request)) return Promise.resolve(invalid());
  const durable = operationFor(request);
  return durable === null
    ? requireProgression(store, request)
    : commitDurableObservation(store, request, durable.operation, durable.observation);
};

const processExecuteObservation = (
  store: RunStore,
  input: LifecycleProcessExecuteObservationRequest,
): Promise<LifecycleProcessObservationResult> => {
  let request;
  try {
    request = lifecycleObservationValidation.processExecuteRequest(input);
  } catch {
    return Promise.resolve(invalid());
  }
  return process(store, request);
};

const processReconcileObservation = (
  store: RunStore,
  input: LifecycleProcessReconcileObservationRequest,
): Promise<LifecycleProcessObservationResult> => {
  let request;
  try {
    request = lifecycleObservationValidation.processReconcileRequest(input);
  } catch {
    return Promise.resolve(invalid());
  }
  return process(store, request);
};

export const executorObservationProcessing = Object.freeze({
  processExecute: processExecuteObservation,
  processReconcile: processReconcileObservation,
});
