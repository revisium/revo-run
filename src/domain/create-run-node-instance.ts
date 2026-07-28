import type { JsonValue } from '../spec/index.js';
import { deriveActivationKey } from './derive-activation-key.js';
import { domainValidation } from './domain-validation.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunNodeStatus } from './run-node-status.js';
import { snapshotRunFault } from './snapshot-run-fault.js';

const nodeStatus = (value: JsonValue | undefined): RunNodeStatus => {
  if (
    value === 'ready' ||
    value === 'executing' ||
    value === 'retry_waiting' ||
    value === 'unknown' ||
    value === 'gate_waiting' ||
    value === 'join_waiting' ||
    value === 'selector_waiting' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'skipped' ||
    value === 'retiring' ||
    value === 'retired'
  ) {
    return value;
  }
  throw new TypeError('Run node status is invalid.');
};

const nullableString = (value: JsonValue | undefined): string | null =>
  value === null ? null : domainValidation.boundedString(value);

const nullableTimestamp = (value: JsonValue | undefined): number | null =>
  value === null ? null : domainValidation.nonnegativeInteger(value);

export const createRunNodeInstance = (value: unknown): RunNodeInstance => {
  const record = domainValidation.record(value);
  domainValidation.exactKeys(record, [
    'activationContext',
    'activationId',
    'activationKey',
    'activeAttemptId',
    'branchKey',
    'createdAt',
    'forkScopeKey',
    'id',
    'iteration',
    'nodeKey',
    'parentActivationId',
    'retryAvailableAt',
    'revision',
    'runId',
    'status',
    'terminalAt',
    'terminalFault',
    'updatedAt',
  ]);
  const status = nodeStatus(record['status']);
  const activeAttemptId = nullableString(record['activeAttemptId']);
  const retryAvailableAt = nullableTimestamp(record['retryAvailableAt']);
  const terminalAt = nullableTimestamp(record['terminalAt']);
  const faultValue = record['terminalFault'];
  const terminalFault = faultValue === null ? null : snapshotRunFault(faultValue);
  const createdAt = domainValidation.nonnegativeInteger(record['createdAt']);
  const updatedAt = domainValidation.nonnegativeInteger(record['updatedAt']);
  const active = status === 'executing' || status === 'unknown' || status === 'retiring';
  const terminal =
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'skipped' ||
    status === 'retired';

  if (active !== (activeAttemptId !== null)) {
    throw new TypeError('Run node active Attempt pointer is invalid.');
  }
  if ((status === 'retry_waiting') !== (retryAvailableAt !== null)) {
    throw new TypeError('Run node retry availability is invalid.');
  }
  if (terminal !== (terminalAt !== null)) throw new TypeError('Run node terminal time is invalid.');
  if (status === 'failed' ? terminalFault === null : terminalFault !== null) {
    throw new TypeError('Run node terminal fault is invalid.');
  }
  if (
    updatedAt < createdAt ||
    (terminalAt !== null && (terminalAt < createdAt || terminalAt > updatedAt)) ||
    (retryAvailableAt !== null && retryAvailableAt < updatedAt)
  ) {
    throw new TypeError('Run node timestamps are inconsistent.');
  }

  const activationKey = domainValidation.canonicalDigest(record['activationKey']);
  const branchKey = nullableString(record['branchKey']);
  const forkScopeKey = domainValidation.canonicalDigest(record['forkScopeKey']);
  const iteration = domainValidation.nonnegativeInteger(record['iteration']);
  const nodeKey = domainValidation.boundedString(record['nodeKey']);
  if (activationKey !== deriveActivationKey({ branchKey, forkScopeKey, iteration, nodeKey })) {
    throw new TypeError('Run node activation key is invalid.');
  }

  return Object.freeze({
    activationContext: domainValidation.required(record, 'activationContext'),
    activationId: domainValidation.boundedString(record['activationId']),
    activationKey,
    activeAttemptId,
    branchKey,
    createdAt,
    forkScopeKey,
    id: domainValidation.boundedString(record['id']),
    iteration,
    nodeKey,
    parentActivationId: nullableString(record['parentActivationId']),
    retryAvailableAt,
    revision: domainValidation.nonnegativeInteger(record['revision']),
    runId: domainValidation.boundedString(record['runId']),
    status,
    terminalAt,
    terminalFault,
    updatedAt,
  });
};
