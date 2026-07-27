import {
  snapshotExecutionPlanPin,
  snapshotExecutorContractPin,
  snapshotLeasePolicy,
  snapshotPortableJsonValue,
  snapshotRunExecutionPlanDocument,
} from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type { LifecycleAcquireRequest } from './lifecycle-acquire-request.js';
import type { LifecycleActiveAttemptPhase } from './lifecycle-active-attempt-phase.js';
import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';
import type { LifecycleClaimRequest } from './lifecycle-claim-request.js';
import type { LifecycleDiscoveryCandidate } from './lifecycle-discovery-candidate.js';
import type { LifecycleDiscoveryCursor } from './lifecycle-discovery-cursor.js';
import type { LifecycleDiscoveryKind } from './lifecycle-discovery-kind.js';
import type { LifecycleDiscoveryRequest } from './lifecycle-discovery-request.js';
import type { LifecycleHydrateOwnedAuthorityRequest } from './lifecycle-hydrate-owned-authority-request.js';
import type { LifecycleNodePhase } from './lifecycle-node-phase.js';
import type { LifecycleRenewLeaseRequest } from './lifecycle-renew-lease-request.js';
import type { LifecycleVerifyAndStartRequest } from './lifecycle-verify-and-start-request.js';
import type { LifecycleWriteHandoffRequest } from './lifecycle-write-handoff-request.js';

type JsonRecord = { readonly [key: string]: JsonValue };

const isRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

const record = (value: unknown, keys: readonly string[]): JsonRecord => {
  const snapshot = snapshotPortableJsonValue(value);
  if (!isRecord(snapshot)) throw new TypeError('INVALID_INPUT');
  const actual = Object.keys(snapshot);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new TypeError('INVALID_INPUT');
  }
  return snapshot;
};

const text = (value: JsonValue | undefined, maximumBytes = 256): string => {
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

const integer = (value: JsonValue | undefined): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('INVALID_INPUT');
  }
  return value;
};

const nullableText = (value: JsonValue | undefined): string | null =>
  value === null ? null : text(value);

const attemptPhase = (value: JsonValue | undefined): LifecycleActiveAttemptPhase => {
  if (
    value !== 'claimed' &&
    value !== 'start_committed' &&
    value !== 'unknown' &&
    value !== 'reconciling'
  ) {
    throw new TypeError('INVALID_INPUT');
  }
  return value;
};

const nodePhase = (value: JsonValue | undefined): LifecycleNodePhase => {
  if (value !== 'executing' && value !== 'unknown') throw new TypeError('INVALID_INPUT');
  return value;
};

const digest = (value: JsonValue | undefined): `sha256:${string}` => {
  const snapshot = text(value, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(snapshot)) throw new TypeError('INVALID_INPUT');
  return `sha256:${snapshot.slice(7)}`;
};

const kind = (value: JsonValue | undefined): LifecycleDiscoveryKind => {
  if (
    value !== 'handoff_attempt' &&
    value !== 'expired_attempt' &&
    value !== 'renewable_attempt' &&
    value !== 'claimable_node' &&
    value !== 'cancellation_run' &&
    value !== 'progressable_run'
  ) {
    throw new TypeError('INVALID_INPUT');
  }
  return value;
};

const authority = (value: unknown): LifecycleAttemptAuthority => {
  const source = record(value, [
    'activationId',
    'attemptId',
    'attemptPhase',
    'dispatchIdempotencyKey',
    'executorConfigurationDigest',
    'executorContractPin',
    'expectedAttemptRevision',
    'expectedNodeRevision',
    'expectedRunRevision',
    'fencingToken',
    'leaseExpiresAt',
    'managerIncarnationId',
    'nodeInstanceId',
    'nodeKey',
    'nodePhase',
    'planPin',
    'runId',
  ]);
  return Object.freeze({
    activationId: text(source['activationId']),
    attemptId: text(source['attemptId']),
    attemptPhase: attemptPhase(source['attemptPhase']),
    dispatchIdempotencyKey: text(source['dispatchIdempotencyKey']),
    executorConfigurationDigest: digest(source['executorConfigurationDigest']),
    executorContractPin: snapshotExecutorContractPin(source['executorContractPin']),
    expectedAttemptRevision: integer(source['expectedAttemptRevision']),
    expectedNodeRevision: integer(source['expectedNodeRevision']),
    expectedRunRevision: integer(source['expectedRunRevision']),
    fencingToken: integer(source['fencingToken']),
    leaseExpiresAt: integer(source['leaseExpiresAt']),
    managerIncarnationId: text(source['managerIncarnationId']),
    nodeInstanceId: text(source['nodeInstanceId']),
    nodeKey: text(source['nodeKey']),
    nodePhase: nodePhase(source['nodePhase']),
    planPin: snapshotExecutionPlanPin(source['planPin']),
    runId: text(source['runId']),
  });
};

const discoveryCandidate = (value: unknown): LifecycleDiscoveryCandidate => {
  const source = record(value, ['attempt', 'eligibleAt', 'handoffId', 'kind', 'node', 'run']);
  const candidateKind = kind(source['kind']);
  const runSource = record(source['run'], ['planPin', 'runId', 'runRevision']);
  const run = Object.freeze({
    planPin: snapshotExecutionPlanPin(runSource['planPin']),
    runId: text(runSource['runId']),
    runRevision: integer(runSource['runRevision']),
  });
  const eligibleAt = integer(source['eligibleAt']);
  if (candidateKind === 'cancellation_run' || candidateKind === 'progressable_run') {
    if (source['node'] !== null || source['attempt'] !== null || source['handoffId'] !== null) {
      throw new TypeError('INVALID_INPUT');
    }
    return Object.freeze({
      attempt: null,
      eligibleAt,
      handoffId: null,
      kind: candidateKind,
      node: null,
      run,
    });
  }
  const nodeSource = record(source['node'], ['activeAttemptId', 'nodeInstanceId', 'nodeRevision']);
  const node = {
    activeAttemptId: nullableText(nodeSource['activeAttemptId']),
    nodeInstanceId: text(nodeSource['nodeInstanceId']),
    nodeRevision: integer(nodeSource['nodeRevision']),
  };
  if (candidateKind === 'claimable_node') {
    if (
      node.activeAttemptId !== null ||
      source['attempt'] !== null ||
      source['handoffId'] !== null
    ) {
      throw new TypeError('INVALID_INPUT');
    }
    return Object.freeze({
      attempt: null,
      eligibleAt,
      handoffId: null,
      kind: candidateKind,
      node: Object.freeze({ ...node, activeAttemptId: null }),
      run,
    });
  }
  const attemptSource = record(source['attempt'], [
    'attemptId',
    'attemptPhase',
    'attemptRevision',
    'fencingToken',
    'leaseExpiresAt',
    'managerIncarnationId',
  ]);
  const attempt = Object.freeze({
    attemptId: text(attemptSource['attemptId']),
    attemptPhase: attemptPhase(attemptSource['attemptPhase']),
    attemptRevision: integer(attemptSource['attemptRevision']),
    fencingToken: integer(attemptSource['fencingToken']),
    leaseExpiresAt: integer(attemptSource['leaseExpiresAt']),
    managerIncarnationId: text(attemptSource['managerIncarnationId']),
  });
  if (node.activeAttemptId !== attempt.attemptId) throw new TypeError('INVALID_INPUT');
  if (candidateKind === 'handoff_attempt') {
    return Object.freeze({
      attempt,
      eligibleAt,
      handoffId: text(source['handoffId']),
      kind: candidateKind,
      node: Object.freeze({ ...node, activeAttemptId: attempt.attemptId }),
      run,
    });
  }
  if (source['handoffId'] !== null) throw new TypeError('INVALID_INPUT');
  return Object.freeze({
    attempt,
    eligibleAt,
    handoffId: null,
    kind: candidateKind,
    node: Object.freeze({ ...node, activeAttemptId: attempt.attemptId }),
    run,
  });
};

const discoveryCursor = (value: unknown): LifecycleDiscoveryCursor => {
  const source = record(value, ['highWatermark', 'kinds', 'last', 'renewal']);
  const sourceKinds = source['kinds'];
  if (sourceKinds === undefined || !isJsonArray(sourceKinds)) throw new TypeError('INVALID_INPUT');
  const kinds = Object.freeze(sourceKinds.map((item) => kind(item)));
  const last = record(source['last'], [
    'attemptId',
    'eligibleAt',
    'kind',
    'nodeInstanceId',
    'runId',
  ]);
  const renewal =
    source['renewal'] === null
      ? null
      : (() => {
          const item = record(source['renewal'], ['leasePolicy', 'managerIncarnationId']);
          return Object.freeze({
            leasePolicy: snapshotLeasePolicy(item['leasePolicy']),
            managerIncarnationId: text(item['managerIncarnationId']),
          });
        })();
  return Object.freeze({
    highWatermark: integer(source['highWatermark']),
    kinds,
    last: Object.freeze({
      attemptId: nullableText(last['attemptId']),
      eligibleAt: integer(last['eligibleAt']),
      kind: kind(last['kind']),
      nodeInstanceId: nullableText(last['nodeInstanceId']),
      runId: text(last['runId']),
    }),
    renewal,
  });
};

const discoveryRequest = (value: unknown): LifecycleDiscoveryRequest => {
  const source = record(value, ['kinds', 'limit', 'renewal', 'scan']);
  const sourceKinds = source['kinds'];
  if (sourceKinds === undefined || !isJsonArray(sourceKinds)) throw new TypeError('INVALID_INPUT');
  const kinds = Object.freeze(sourceKinds.map((item) => kind(item)));
  const scanSource = snapshotPortableJsonValue(source['scan']);
  if (!isRecord(scanSource)) throw new TypeError('INVALID_INPUT');
  const scan =
    scanSource['kind'] === 'start'
      ? (() => {
          record(scanSource, ['kind']);
          return Object.freeze({ kind: 'start' as const });
        })()
      : (() => {
          const continuation = record(scanSource, ['cursor', 'kind']);
          if (continuation['kind'] !== 'continue') throw new TypeError('INVALID_INPUT');
          return Object.freeze({
            cursor: discoveryCursor(continuation['cursor']),
            kind: 'continue' as const,
          });
        })();
  const renewal =
    source['renewal'] === null
      ? null
      : (() => {
          const item = record(source['renewal'], ['leasePolicy', 'managerIncarnationId']);
          return Object.freeze({
            leasePolicy: snapshotLeasePolicy(item['leasePolicy']),
            managerIncarnationId: text(item['managerIncarnationId']),
          });
        })();
  return Object.freeze({ kinds, limit: integer(source['limit']), renewal, scan });
};

const claimRequest = (value: unknown): LifecycleClaimRequest => {
  const source = record(value, [
    'candidate',
    'generatedAttemptId',
    'generatedDispatchIdempotencyKey',
    'idempotencyKey',
    'leasePolicy',
    'managerIncarnationId',
    'ownerLabel',
    'planDocument',
  ]);
  const candidate = discoveryCandidate(source['candidate']);
  if (candidate.kind !== 'claimable_node') throw new TypeError('INVALID_INPUT');
  return Object.freeze({
    candidate,
    generatedAttemptId: text(source['generatedAttemptId']),
    generatedDispatchIdempotencyKey: text(source['generatedDispatchIdempotencyKey']),
    idempotencyKey: text(source['idempotencyKey']),
    leasePolicy: snapshotLeasePolicy(source['leasePolicy']),
    managerIncarnationId: text(source['managerIncarnationId']),
    ownerLabel: text(source['ownerLabel'], 512),
    planDocument: snapshotRunExecutionPlanDocument(source['planDocument']),
  });
};

const renewRequest = (value: unknown): LifecycleRenewLeaseRequest => {
  const source = record(value, ['authority', 'leasePolicy']);
  return Object.freeze({
    authority: authority(source['authority']),
    leasePolicy: snapshotLeasePolicy(source['leasePolicy']),
  });
};

const hydrateOwnedAuthorityRequest = (value: unknown): LifecycleHydrateOwnedAuthorityRequest => {
  const source = record(value, [
    'attemptId',
    'expectedAttemptFence',
    'expectedManagerIncarnationId',
    'expectedPhase',
    'nodeInstanceId',
    'runId',
  ]);
  return Object.freeze({
    attemptId: text(source['attemptId']),
    expectedAttemptFence: integer(source['expectedAttemptFence']),
    expectedManagerIncarnationId: text(source['expectedManagerIncarnationId']),
    expectedPhase: attemptPhase(source['expectedPhase']),
    nodeInstanceId: text(source['nodeInstanceId']),
    runId: text(source['runId']),
  });
};

const handoffRequest = (value: unknown): LifecycleWriteHandoffRequest => {
  const source = record(value, ['authority', 'generatedHandoffId', 'idempotencyKey', 'reason']);
  if (
    source['reason'] !== 'manager_progression_unavailable' &&
    source['reason'] !== 'manager_recovery_failure' &&
    source['reason'] !== 'manager_shutdown' &&
    source['reason'] !== 'manager_start_failure'
  ) {
    throw new TypeError('INVALID_INPUT');
  }
  return Object.freeze({
    authority: authority(source['authority']),
    generatedHandoffId: text(source['generatedHandoffId']),
    idempotencyKey: text(source['idempotencyKey']),
    reason: source['reason'],
  });
};

const acquireRequest = (value: unknown): LifecycleAcquireRequest => {
  const source = record(value, [
    'candidate',
    'idempotencyKey',
    'leasePolicy',
    'successorManagerIncarnationId',
  ]);
  const candidate = discoveryCandidate(source['candidate']);
  if (candidate.kind !== 'expired_attempt' && candidate.kind !== 'handoff_attempt') {
    throw new TypeError('INVALID_INPUT');
  }
  return Object.freeze({
    candidate,
    idempotencyKey: text(source['idempotencyKey']),
    leasePolicy: snapshotLeasePolicy(source['leasePolicy']),
    successorManagerIncarnationId: text(source['successorManagerIncarnationId']),
  });
};

const verifyAndStartRequest = (value: unknown): LifecycleVerifyAndStartRequest => {
  const source = record(value, ['authority', 'planDocument']);
  const claimed = authority(source['authority']);
  if (claimed.attemptPhase !== 'claimed' || claimed.nodePhase !== 'executing') {
    throw new TypeError('INVALID_INPUT');
  }
  return Object.freeze({
    authority: Object.freeze({ ...claimed, attemptPhase: 'claimed', nodePhase: 'executing' }),
    planDocument: snapshotRunExecutionPlanDocument(source['planDocument']),
  });
};

export const lifecycleValidation = Object.freeze({
  acquireRequest,
  authority,
  boundedText: text,
  claimRequest,
  discoveryRequest,
  handoffRequest,
  hydrateOwnedAuthorityRequest,
  renewRequest,
  verifyAndStartRequest,
});
