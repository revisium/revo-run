import type { ExecutorFailureFaultCode } from '../errors/index.js';
import { snapshotExecutorOutputs, snapshotPortableJsonValue } from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type { LifecycleExecuteObservation } from './lifecycle-execute-observation.js';
import type { LifecycleKnownObservation } from './lifecycle-known-observation.js';
import type { LifecycleReconcileObservation } from './lifecycle-reconcile-observation.js';

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

const isRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isFailureCode = (value: JsonValue | undefined): value is ExecutorFailureFaultCode =>
  typeof value === 'string' && Object.hasOwn(failureCodes, value);

const unknown = (message: string): LifecycleExecuteObservation =>
  Object.freeze({
    fault: Object.freeze({ code: 'UNKNOWN_OUTCOME', message }),
    kind: 'unknown',
  });

const exactRecord = (value: JsonValue, keys: readonly string[]): JsonRecord => {
  if (!isRecord(value)) {
    throw new TypeError('Executor observation is invalid.');
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError('Executor observation is invalid.');
  }
  return value;
};

const boundedMessage = (value: JsonValue | undefined): string => {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 512) {
    throw new TypeError('Executor observation fault is invalid.');
  }
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point === undefined ||
      point <= 0x1f ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0xd800 && point <= 0xdfff)
    ) {
      throw new TypeError('Executor observation fault is invalid.');
    }
  }
  return value;
};

const knownObservation = (value: JsonValue): LifecycleKnownObservation | null => {
  if (isRecord(value) && value['kind'] === 'unknown') return null;
  const top = exactRecord(
    value,
    isRecord(value) && value['kind'] === 'failed'
      ? ['fault', 'kind']
      : isRecord(value) && value['kind'] === 'succeeded'
        ? ['kind', 'outputs']
        : ['kind'],
  );
  if (top['kind'] === 'cancelled') return Object.freeze({ kind: 'cancelled' });
  if (top['kind'] === 'succeeded') {
    return Object.freeze({
      kind: 'succeeded',
      outputs: snapshotExecutorOutputs(top['outputs']),
    });
  }
  if (top['kind'] !== 'failed') return null;
  const fault = exactRecord(top['fault'] ?? null, ['code', 'message']);
  const code = fault['code'];
  if (!isFailureCode(code)) {
    throw new TypeError('Executor observation fault is invalid.');
  }
  return Object.freeze({
    fault: Object.freeze({ code, message: boundedMessage(fault['message']) }),
    kind: 'failed',
  });
};

const normalizeExecuteValue = (value: unknown): LifecycleExecuteObservation => {
  try {
    const snapshot = snapshotPortableJsonValue(value);
    const known = knownObservation(snapshot);
    if (known !== null) return known;
    const top = exactRecord(snapshot, ['fault', 'kind']);
    if (top['kind'] !== 'unknown') throw new TypeError('Executor observation is invalid.');
    const fault = exactRecord(top['fault'] ?? null, ['code', 'message']);
    if (fault['code'] !== 'UNKNOWN_OUTCOME') {
      throw new TypeError('Executor observation fault is invalid.');
    }
    return unknown(boundedMessage(fault['message']));
  } catch {
    return unknown('Execution outcome is unknown.');
  }
};

const invokeExecuteAndNormalize = async (
  invoke: () => Promise<unknown>,
): Promise<LifecycleExecuteObservation> => {
  try {
    return normalizeExecuteValue(await invoke());
  } catch {
    return unknown('Execution outcome is unknown.');
  }
};

const invokeReconcileAndNormalize = async (
  invoke: () => Promise<unknown>,
): Promise<LifecycleReconcileObservation> => {
  let value;
  try {
    value = await invoke();
  } catch {
    return unknown('Reconciliation outcome is unknown.');
  }
  try {
    const snapshot = snapshotPortableJsonValue(value);
    const known = knownObservation(snapshot);
    if (known !== null) return known;
    const top = exactRecord(
      snapshot,
      isRecord(snapshot) && snapshot['kind'] === 'unknown' ? ['fault', 'kind'] : ['kind'],
    );
    if (top['kind'] === 'running') return Object.freeze({ kind: 'running' });
    if (top['kind'] === 'not_found') return unknown('Reconciliation found no execution.');
    if (top['kind'] !== 'unknown') throw new TypeError('Executor observation is invalid.');
    const fault = exactRecord(top['fault'] ?? null, ['code', 'message']);
    if (fault['code'] !== 'UNKNOWN_OUTCOME') {
      throw new TypeError('Executor observation fault is invalid.');
    }
    return unknown(boundedMessage(fault['message']));
  } catch {
    return unknown('Reconciliation outcome is unknown.');
  }
};

const normalizeCancelAdapterResult = (
  value: unknown,
): { readonly kind: 'cancelled' | 'unconfirmed' } => {
  try {
    const snapshot = snapshotPortableJsonValue(value);
    const top = exactRecord(snapshot, ['kind']);
    return Object.freeze({
      kind: top['kind'] === 'cancelled' ? 'cancelled' : 'unconfirmed',
    });
  } catch {
    return Object.freeze({ kind: 'unconfirmed' });
  }
};

export const executorObservationNormalization = Object.freeze({
  normalizeCancel: normalizeCancelAdapterResult,
  invokeExecute: invokeExecuteAndNormalize,
  invokeReconcile: invokeReconcileAndNormalize,
});
