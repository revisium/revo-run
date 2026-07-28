import { snapshotExecutionPlanPin, snapshotRunProgressionState } from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import { domainValidation } from './domain-validation.js';
import type { RunStatus } from './run-status.js';
import type { Run } from './run.js';
import { snapshotRunFault } from './snapshot-run-fault.js';

const runStatus = (value: JsonValue | undefined): RunStatus => {
  if (
    value === 'running' ||
    value === 'cancelling' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw new TypeError('Run status is invalid.');
};

const nullableTimestamp = (value: JsonValue | undefined): number | null =>
  value === null ? null : domainValidation.nonnegativeInteger(value);

export const createRun = (value: unknown): Run => {
  const record = domainValidation.record(value);
  domainValidation.exactKeys(
    record,
    [
      'cancellationRequestedAt',
      'createdAt',
      'id',
      'input',
      'planPin',
      'progression',
      'revision',
      'status',
      'terminalAt',
      'terminalFault',
      'updatedAt',
    ],
    ['metadata'],
  );
  const status = runStatus(record['status']);
  const createdAt = domainValidation.nonnegativeInteger(record['createdAt']);
  const updatedAt = domainValidation.nonnegativeInteger(record['updatedAt']);
  const cancellationRequestedAt = nullableTimestamp(record['cancellationRequestedAt']);
  const terminalAt = nullableTimestamp(record['terminalAt']);
  const faultValue = record['terminalFault'];
  const terminalFault = faultValue === null ? null : snapshotRunFault(faultValue);
  const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';

  if (
    updatedAt < createdAt ||
    (cancellationRequestedAt !== null &&
      (cancellationRequestedAt < createdAt || cancellationRequestedAt > updatedAt)) ||
    (terminalAt !== null && (terminalAt < createdAt || terminalAt > updatedAt)) ||
    (cancellationRequestedAt !== null &&
      terminalAt !== null &&
      cancellationRequestedAt > terminalAt)
  ) {
    throw new TypeError('Run timestamps are inconsistent.');
  }
  if (terminal !== (terminalAt !== null)) throw new TypeError('Run terminal time is invalid.');
  if (status === 'failed' ? terminalFault === null : terminalFault !== null) {
    throw new TypeError('Run terminal fault is invalid.');
  }
  if (
    (status === 'running' && cancellationRequestedAt !== null) ||
    (status === 'cancelling' && cancellationRequestedAt === null)
  ) {
    throw new TypeError('Run cancellation time is invalid.');
  }

  const common = {
    cancellationRequestedAt,
    createdAt,
    id: domainValidation.boundedString(record['id']),
    input: domainValidation.required(record, 'input'),
    planPin: snapshotExecutionPlanPin(domainValidation.required(record, 'planPin')),
    progression: snapshotRunProgressionState(domainValidation.required(record, 'progression')),
    revision: domainValidation.nonnegativeInteger(record['revision']),
    status,
    terminalAt,
    terminalFault,
    updatedAt,
  };
  const metadata = record['metadata'];
  if (metadata === undefined) return Object.freeze(common);
  return Object.freeze({ ...common, metadata });
};
