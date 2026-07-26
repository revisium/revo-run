import { canonicalizeJson, snapshotPortableJsonValue } from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type { RunStoreIdempotencyIdentity, RunStoreIdempotencyRecord } from '../storage/index.js';
import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';
import type { LifecycleReplayed } from './lifecycle-replayed.js';
import { lifecycleSupport } from './lifecycle-support.js';

type JsonRecord = Readonly<Record<string, JsonValue>>;

const { conflict, invalid, mapCursor } = lifecycleSupport;

const isRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactObservationRecord = (
  value: JsonValue | undefined,
  keys: readonly string[],
): JsonRecord => {
  if (value === undefined || !isRecord(value)) {
    throw new TypeError('Observation replay is invalid.');
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError('Observation replay is invalid.');
  }
  return value;
};

const observationText = (value: JsonValue | undefined): string => {
  const snapshot = lifecycleSupport.boundedString(value);
  return snapshot;
};

const observationInteger = (value: JsonValue | undefined): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Observation replay is invalid.');
  }
  return value;
};

const mapObservationReplay = <Value>(
  source: RunStoreIdempotencyRecord,
  expectedIdentity: RunStoreIdempotencyIdentity,
  expectedRequest: JsonValue,
  expectedResult: JsonValue,
  parseValue: (value: JsonValue) => Value,
): LifecycleReplayed<Value> | LifecycleConflictResult | LifecycleFaultResult => {
  try {
    const snapshot = snapshotPortableJsonValue(source);
    const top = exactObservationRecord(snapshot, [
      'committedAt',
      'cursor',
      'identity',
      'request',
      'result',
    ]);
    const identity = exactObservationRecord(top['identity'], [
      'key',
      'operation',
      'runId',
      'subjectId',
    ]);
    const cursor = exactObservationRecord(top['cursor'], ['runId', 'sequence']);
    if (
      observationText(identity['key']) !== expectedIdentity.key ||
      observationText(identity['operation']) !== expectedIdentity.operation ||
      observationText(identity['runId']) !== expectedIdentity.runId ||
      observationText(identity['subjectId']) !== expectedIdentity.subjectId ||
      observationText(cursor['runId']) !== expectedIdentity.runId
    ) {
      throw new TypeError('Observation replay identity is invalid.');
    }
    if (canonicalizeJson(top['request'] ?? null) !== canonicalizeJson(expectedRequest)) {
      return conflict({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Observation identity was reused with different semantics.',
      });
    }
    if (canonicalizeJson(top['result'] ?? null) !== canonicalizeJson(expectedResult)) {
      throw new TypeError('Observation replay result is invalid.');
    }
    return Object.freeze({
      committedAt: observationInteger(top['committedAt']),
      cursor: mapCursor({
        runId: expectedIdentity.runId ?? '',
        sequence: observationInteger(cursor['sequence']),
      }),
      kind: 'replayed',
      value: parseValue(top['result'] ?? null),
    });
  } catch {
    return invalid();
  }
};

export const lifecycleObservationReplay = Object.freeze({
  exactRecord: exactObservationRecord,
  integer: observationInteger,
  map: mapObservationReplay,
  text: observationText,
});
