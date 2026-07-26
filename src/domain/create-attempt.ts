import type { RunFault } from '../errors/index.js';
import { snapshotExecutorContractPin, snapshotRunFaultMessage } from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type { AttemptStatus } from './attempt-status.js';
import type { Attempt } from './attempt.js';
import { domainValidation } from './domain-validation.js';
import { snapshotRunFault } from './snapshot-run-fault.js';

const attemptStatus = (value: JsonValue | undefined): AttemptStatus => {
  if (
    value === 'claimed' ||
    value === 'start_committed' ||
    value === 'unknown' ||
    value === 'reconciling' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw new TypeError('Attempt status is invalid.');
};

const nullableTimestamp = (value: JsonValue | undefined): number | null =>
  value === null ? null : domainValidation.nonnegativeInteger(value);

const configurationDigest = (value: JsonValue | undefined): `sha256:${string}` => {
  const text = domainValidation.boundedString(value, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) {
    throw new TypeError('Executor configuration digest is invalid.');
  }
  return `sha256:${text.slice(7)}`;
};

const faultMatchesStatus = (status: AttemptStatus, fault: RunFault | null): boolean => {
  if (status === 'failed') return fault !== null;
  if (status === 'unknown' || status === 'reconciling') {
    return fault?.code === 'UNKNOWN_OUTCOME';
  }
  return fault === null;
};

export const createAttempt = (value: unknown): Attempt => {
  const record = domainValidation.record(value);
  domainValidation.exactKeys(record, [
    'createdAt',
    'dispatchIdempotencyKey',
    'executorConfigurationDigest',
    'executorContractPin',
    'fault',
    'fencingToken',
    'id',
    'lastHeartbeatAt',
    'leaseExpiresAt',
    'managerIncarnationId',
    'nodeInstanceId',
    'ordinal',
    'ownerLabel',
    'revision',
    'runId',
    'startCommittedAt',
    'status',
    'terminalAt',
    'updatedAt',
  ]);
  const status = attemptStatus(record['status']);
  const faultValue = record['fault'];
  const fault = faultValue === null ? null : snapshotRunFault(faultValue);
  const createdAt = domainValidation.nonnegativeInteger(record['createdAt']);
  const updatedAt = domainValidation.nonnegativeInteger(record['updatedAt']);
  const lastHeartbeatAt = domainValidation.nonnegativeInteger(record['lastHeartbeatAt']);
  const leaseExpiresAt = domainValidation.nonnegativeInteger(record['leaseExpiresAt']);
  const startCommittedAt = nullableTimestamp(record['startCommittedAt']);
  const terminalAt = nullableTimestamp(record['terminalAt']);
  const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';

  if (
    (status === 'claimed' && startCommittedAt !== null) ||
    ((status === 'start_committed' ||
      status === 'unknown' ||
      status === 'reconciling' ||
      status === 'succeeded') &&
      startCommittedAt === null)
  ) {
    throw new TypeError('Attempt Start time is invalid.');
  }
  if (terminal !== (terminalAt !== null)) throw new TypeError('Attempt terminal time is invalid.');
  if (!faultMatchesStatus(status, fault)) {
    throw new TypeError('Attempt fault is invalid.');
  }
  if (
    updatedAt < createdAt ||
    lastHeartbeatAt < createdAt ||
    lastHeartbeatAt > updatedAt ||
    leaseExpiresAt <= lastHeartbeatAt ||
    (startCommittedAt !== null && (startCommittedAt < createdAt || startCommittedAt > updatedAt)) ||
    (terminalAt !== null &&
      (terminalAt < createdAt ||
        terminalAt > updatedAt ||
        (startCommittedAt !== null && terminalAt < startCommittedAt)))
  ) {
    throw new TypeError('Attempt timestamps are inconsistent.');
  }

  return Object.freeze({
    createdAt,
    dispatchIdempotencyKey: domainValidation.boundedString(record['dispatchIdempotencyKey']),
    executorConfigurationDigest: configurationDigest(record['executorConfigurationDigest']),
    executorContractPin: snapshotExecutorContractPin(
      domainValidation.required(record, 'executorContractPin'),
    ),
    fault,
    fencingToken: domainValidation.nonnegativeInteger(record['fencingToken']),
    id: domainValidation.boundedString(record['id']),
    lastHeartbeatAt,
    leaseExpiresAt,
    managerIncarnationId: domainValidation.boundedString(record['managerIncarnationId']),
    nodeInstanceId: domainValidation.boundedString(record['nodeInstanceId']),
    ordinal: domainValidation.nonnegativeInteger(record['ordinal']),
    ownerLabel: snapshotRunFaultMessage(record['ownerLabel']),
    revision: domainValidation.nonnegativeInteger(record['revision']),
    runId: domainValidation.boundedString(record['runId']),
    startCommittedAt,
    status,
    terminalAt,
    updatedAt,
  });
};
