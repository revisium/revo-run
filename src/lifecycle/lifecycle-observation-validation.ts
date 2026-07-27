import {
  snapshotExecutorOutputs,
  snapshotPortableJsonValue,
  snapshotRunExecutionPlanDocument,
} from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type { LifecycleExecuteObservation } from './lifecycle-execute-observation.js';
import type { LifecyclePrepareReconciliationRequest } from './lifecycle-prepare-reconciliation-request.js';
import type { LifecycleProcessExecuteObservationRequest } from './lifecycle-process-execute-observation-request.js';
import type { LifecycleProcessReconcileObservationRequest } from './lifecycle-process-reconcile-observation-request.js';
import type { LifecycleReconcileObservation } from './lifecycle-reconcile-observation.js';
import { lifecycleValidation } from './lifecycle-validation.js';

type JsonRecord = Readonly<Record<string, JsonValue>>;

const failureCodes = Object.freeze({
  EXECUTOR_MISMATCH: true,
  EXECUTOR_UNAVAILABLE: true,
  INVALID_INPUT: true,
  INVALID_STATE: true,
  PLAN_MISMATCH: true,
  PLAN_UNAVAILABLE: true,
  REVISION_CONFLICT: true,
  STALE_ACTIVATION: true,
  STALE_FENCE: true,
});

type FailureCode =
  | 'EXECUTOR_MISMATCH'
  | 'EXECUTOR_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'PLAN_MISMATCH'
  | 'PLAN_UNAVAILABLE'
  | 'REVISION_CONFLICT'
  | 'STALE_ACTIVATION'
  | 'STALE_FENCE';

const isRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isArray = (value: JsonValue | undefined): value is readonly JsonValue[] =>
  Array.isArray(value);

const exactRecord = (value: JsonValue, keys: readonly string[]): JsonRecord => {
  if (!isRecord(value)) throw new TypeError('INVALID_INPUT');
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError('INVALID_INPUT');
  }
  return value;
};

const record = (value: unknown, keys: readonly string[]): JsonRecord =>
  exactRecord(snapshotPortableJsonValue(value), keys);

const text = (value: JsonValue | undefined): string => lifecycleValidation.boundedText(value);

const faultMessage = (value: JsonValue | undefined): string =>
  lifecycleValidation.boundedText(value, 512);

const required = (value: JsonRecord, key: string): JsonValue => {
  const member = value[key];
  if (member === undefined) throw new TypeError('INVALID_INPUT');
  return member;
};

const failureCode = (value: JsonValue | undefined): FailureCode => {
  if (typeof value !== 'string' || !Object.hasOwn(failureCodes, value)) {
    throw new TypeError('INVALID_INPUT');
  }
  switch (value) {
    case 'EXECUTOR_MISMATCH':
    case 'EXECUTOR_UNAVAILABLE':
    case 'INVALID_INPUT':
    case 'INVALID_STATE':
    case 'PLAN_MISMATCH':
    case 'PLAN_UNAVAILABLE':
    case 'REVISION_CONFLICT':
    case 'STALE_ACTIVATION':
    case 'STALE_FENCE':
      return value;
    default:
      throw new TypeError('INVALID_INPUT');
  }
};

const failureFault = (value: JsonValue | undefined) => {
  if (value === undefined) throw new TypeError('INVALID_INPUT');
  const source = exactRecord(value, ['code', 'message']);
  return Object.freeze({
    code: failureCode(source['code']),
    message: faultMessage(source['message']),
  });
};

const unknownFault = (value: JsonValue | undefined) => {
  if (value === undefined) throw new TypeError('INVALID_INPUT');
  const source = exactRecord(value, ['code', 'message']);
  if (source['code'] !== 'UNKNOWN_OUTCOME') throw new TypeError('INVALID_INPUT');
  return Object.freeze({
    code: 'UNKNOWN_OUTCOME' as const,
    message: faultMessage(source['message']),
  });
};

const kindOf = (value: JsonValue): JsonValue | undefined =>
  isRecord(value) ? value['kind'] : undefined;

const executeObservationKeys = (kind: JsonValue | undefined): readonly string[] => {
  if (kind === 'succeeded') return ['kind', 'outputs'];
  if (kind === 'failed' || kind === 'unknown') return ['fault', 'kind'];
  return ['kind'];
};

const executeObservation = (value: JsonValue): LifecycleExecuteObservation => {
  const kind = kindOf(value);
  const source = exactRecord(value, executeObservationKeys(kind));
  if (source['kind'] === 'cancelled') return Object.freeze({ kind: 'cancelled' });
  if (source['kind'] === 'succeeded') {
    return Object.freeze({
      kind: 'succeeded',
      outputs: snapshotExecutorOutputs(source['outputs']),
    });
  }
  if (source['kind'] === 'failed') {
    return Object.freeze({ fault: failureFault(source['fault']), kind: 'failed' });
  }
  if (source['kind'] === 'unknown') {
    return Object.freeze({ fault: unknownFault(source['fault']), kind: 'unknown' });
  }
  throw new TypeError('INVALID_INPUT');
};

const reconcileObservation = (value: JsonValue): LifecycleReconcileObservation => {
  const execute = executeObservation(value);
  if (execute.kind !== 'unknown') return execute;
  const source = exactRecord(value, ['fault', 'kind']);
  if (source['kind'] === 'unknown') return execute;
  throw new TypeError('INVALID_INPUT');
};

const reconciliationObservation = (value: JsonValue): LifecycleReconcileObservation => {
  const kind = kindOf(value);
  if (kind === 'running') {
    exactRecord(value, ['kind']);
    return Object.freeze({ kind: 'running' });
  }
  return reconcileObservation(value);
};

const outputIds = (value: JsonValue | undefined): readonly string[] => {
  if (!isArray(value) || value.length > 4_096) throw new TypeError('INVALID_INPUT');
  const values = Object.freeze(value.map((item) => text(item)));
  if (new Set(values).size !== values.length) throw new TypeError('INVALID_INPUT');
  return values;
};

const prepareRequest = (value: unknown): LifecyclePrepareReconciliationRequest => {
  const source = record(value, ['authority', 'beginIdempotencyKey', 'planDocument']);
  const authority = lifecycleValidation.authority(source['authority']);
  if (authority.attemptPhase !== 'unknown' || authority.nodePhase !== 'unknown') {
    throw new TypeError('INVALID_INPUT');
  }
  return Object.freeze({
    authority: Object.freeze({ ...authority, attemptPhase: 'unknown', nodePhase: 'unknown' }),
    beginIdempotencyKey: text(source['beginIdempotencyKey']),
    planDocument: snapshotRunExecutionPlanDocument(source['planDocument']),
  });
};

const processExecuteRequest = (value: unknown): LifecycleProcessExecuteObservationRequest => {
  const source = record(value, [
    'authority',
    'generatedOutputIds',
    'idempotencyKey',
    'observation',
  ]);
  const authority = lifecycleValidation.authority(source['authority']);
  if (authority.attemptPhase !== 'start_committed' || authority.nodePhase !== 'executing') {
    throw new TypeError('INVALID_INPUT');
  }
  return Object.freeze({
    authority: Object.freeze({
      ...authority,
      attemptPhase: 'start_committed',
      nodePhase: 'executing',
    }),
    generatedOutputIds: outputIds(source['generatedOutputIds']),
    idempotencyKey: text(source['idempotencyKey']),
    observation: executeObservation(required(source, 'observation')),
  });
};

const processReconcileRequest = (value: unknown): LifecycleProcessReconcileObservationRequest => {
  const source = record(value, [
    'authority',
    'generatedOutputIds',
    'idempotencyKey',
    'observation',
  ]);
  const authority = lifecycleValidation.authority(source['authority']);
  if (authority.attemptPhase !== 'reconciling' || authority.nodePhase !== 'unknown') {
    throw new TypeError('INVALID_INPUT');
  }
  return Object.freeze({
    authority: Object.freeze({
      ...authority,
      attemptPhase: 'reconciling',
      nodePhase: 'unknown',
    }),
    generatedOutputIds: outputIds(source['generatedOutputIds']),
    idempotencyKey: text(source['idempotencyKey']),
    observation: reconciliationObservation(required(source, 'observation')),
  });
};

export const lifecycleObservationValidation = Object.freeze({
  prepareRequest,
  processExecuteRequest,
  processReconcileRequest,
});
