import { snapshotExecutorContractPin } from '../policy/index.js';
import type { JsonValue } from '../spec/index.js';
import type { Attempt } from './attempt.js';
import { createAttempt } from './create-attempt.js';
import { createRunNodeInstance } from './create-run-node-instance.js';
import { createRunOutput } from './create-run-output.js';
import { createRun } from './create-run.js';
import type { DomainAuthority } from './domain-authority.js';
import type { DomainOperation } from './domain-operation.js';
import { domainValidation } from './domain-validation.js';
import type { RunNodeInstance } from './run-node-instance.js';
import type { RunOutput } from './run-output.js';
import { snapshotRunFault } from './snapshot-run-fault.js';

type JsonRecord = { readonly [key: string]: JsonValue };

const attemptOperationKeys = ['attempt', 'authority', 'kind', 'node', 'run'] as const;

const required = (record: JsonRecord, key: string): JsonValue =>
  domainValidation.required(record, key);

const reconstructAuthority = (value: JsonValue): DomainAuthority => {
  const record = domainValidation.record(value);
  domainValidation.exactKeys(record, [
    'attemptId',
    'executorConfigurationDigest',
    'executorContractPin',
    'expectedAttemptRevision',
    'expectedNodeRevision',
    'expectedRunRevision',
    'fencingToken',
    'managerIncarnationId',
    'transactionNow',
  ]);

  return Object.freeze({
    attemptId: domainValidation.boundedString(record['attemptId']),
    executorConfigurationDigest: domainValidation.canonicalDigest(
      record['executorConfigurationDigest'],
    ),
    executorContractPin: snapshotExecutorContractPin(required(record, 'executorContractPin')),
    expectedAttemptRevision: domainValidation.nonnegativeInteger(record['expectedAttemptRevision']),
    expectedNodeRevision: domainValidation.nonnegativeInteger(record['expectedNodeRevision']),
    expectedRunRevision: domainValidation.nonnegativeInteger(record['expectedRunRevision']),
    fencingToken: domainValidation.nonnegativeInteger(record['fencingToken']),
    managerIncarnationId: domainValidation.boundedString(record['managerIncarnationId']),
    transactionNow: domainValidation.nonnegativeInteger(record['transactionNow']),
  });
};

const reconstructOutputs = (value: JsonValue): readonly RunOutput[] => {
  if (!Array.isArray(value)) throw new TypeError('Run domain input is invalid.');
  return Object.freeze(value.map((output) => createRunOutput(output)));
};

const reconstructNodes = (value: JsonValue): readonly RunNodeInstance[] => {
  if (!Array.isArray(value)) throw new TypeError('Run domain input is invalid.');
  return Object.freeze(value.map((node) => createRunNodeInstance(node)));
};

const reconstructAttempts = (value: JsonValue): readonly Attempt[] => {
  if (!Array.isArray(value)) throw new TypeError('Run domain input is invalid.');
  return Object.freeze(value.map((attempt) => createAttempt(attempt)));
};

const reconstructAttemptBase = (record: JsonRecord) => ({
  attempt: createAttempt(required(record, 'attempt')),
  authority: reconstructAuthority(required(record, 'authority')),
  node: createRunNodeInstance(required(record, 'node')),
  run: createRun(required(record, 'run')),
});

const reconstructExpectedRevisions = (record: JsonRecord) => ({
  expectedNodeRevision: domainValidation.nonnegativeInteger(record['expectedNodeRevision']),
  expectedRunRevision: domainValidation.nonnegativeInteger(record['expectedRunRevision']),
});

const reconstructFailure = (record: JsonRecord) => ({
  fault: snapshotRunFault(required(record, 'fault')),
  retryAvailableAt:
    record['retryAvailableAt'] === null
      ? null
      : domainValidation.nonnegativeInteger(record['retryAvailableAt']),
});

export const reconstructDomainOperation = (value: unknown): DomainOperation => {
  const record = domainValidation.record(value);
  const kind = required(record, 'kind');
  if (typeof kind !== 'string') throw new TypeError('Run domain operation kind is invalid.');

  switch (kind) {
    case 'activate_nodes':
      domainValidation.exactKeys(record, ['kind', 'nodes', 'run', 'transactionNow']);
      return {
        kind,
        nodes: reconstructNodes(required(record, 'nodes')),
        run: createRun(required(record, 'run')),
        transactionNow: domainValidation.nonnegativeInteger(record['transactionNow']),
      };
    case 'claim':
      domainValidation.exactKeys(record, [
        'attempt',
        'expectedNodeRevision',
        'expectedRunRevision',
        'kind',
        'node',
        'run',
        'transactionNow',
      ]);
      return {
        attempt: createAttempt(required(record, 'attempt')),
        ...reconstructExpectedRevisions(record),
        kind,
        node: createRunNodeInstance(required(record, 'node')),
        run: createRun(required(record, 'run')),
        transactionNow: domainValidation.nonnegativeInteger(record['transactionNow']),
      };
    case 'start':
    case 'pre_start_cancellation':
    case 'direct_cancellation':
    case 'begin_reconciliation':
    case 'late_cancellation':
    case 'reconciled_running':
    case 'reconciled_unknown':
    case 'reconciled_cancellation':
      domainValidation.exactKeys(record, attemptOperationKeys);
      return { kind, ...reconstructAttemptBase(record) };
    case 'renew_lease':
      domainValidation.exactKeys(record, [
        ...attemptOperationKeys,
        'nextLastHeartbeatAt',
        'nextLeaseExpiresAt',
      ]);
      return {
        kind,
        ...reconstructAttemptBase(record),
        nextLastHeartbeatAt: domainValidation.nonnegativeInteger(record['nextLastHeartbeatAt']),
        nextLeaseExpiresAt: domainValidation.nonnegativeInteger(record['nextLeaseExpiresAt']),
      };
    case 'pre_start_failure':
    case 'direct_failure':
    case 'late_failure':
    case 'reconciled_failure':
      domainValidation.exactKeys(record, [...attemptOperationKeys, 'fault', 'retryAvailableAt']);
      return {
        kind,
        ...reconstructAttemptBase(record),
        ...reconstructFailure(record),
      };
    case 'direct_success':
    case 'late_success':
    case 'reconciled_success':
      domainValidation.exactKeys(record, [...attemptOperationKeys, 'outputs']);
      return {
        kind,
        ...reconstructAttemptBase(record),
        outputs: reconstructOutputs(required(record, 'outputs')),
      };
    case 'direct_unknown':
      domainValidation.exactKeys(record, [...attemptOperationKeys, 'fault']);
      return {
        kind,
        ...reconstructAttemptBase(record),
        fault: snapshotRunFault(required(record, 'fault')),
      };
    case 'request_cancellation':
      domainValidation.exactKeys(record, ['attempts', 'kind', 'nodes', 'run', 'transactionNow']);
      return {
        attempts: reconstructAttempts(required(record, 'attempts')),
        kind,
        nodes: reconstructNodes(required(record, 'nodes')),
        run: createRun(required(record, 'run')),
        transactionNow: domainValidation.nonnegativeInteger(record['transactionNow']),
      };
    case 'gate_answer':
      domainValidation.exactKeys(record, [
        'expectedNodeRevision',
        'expectedRunRevision',
        'kind',
        'node',
        'output',
        'run',
        'transactionNow',
      ]);
      return {
        ...reconstructExpectedRevisions(record),
        kind,
        node: createRunNodeInstance(required(record, 'node')),
        output: createRunOutput(required(record, 'output')),
        run: createRun(required(record, 'run')),
        transactionNow: domainValidation.nonnegativeInteger(record['transactionNow']),
      };
    case 'join_ready':
    case 'join_succeeded':
      domainValidation.exactKeys(record, [
        'expectedNodeRevision',
        'expectedRunRevision',
        'kind',
        'node',
        'run',
        'transactionNow',
      ]);
      return {
        ...reconstructExpectedRevisions(record),
        kind,
        node: createRunNodeInstance(required(record, 'node')),
        run: createRun(required(record, 'run')),
        transactionNow: domainValidation.nonnegativeInteger(record['transactionNow']),
      };
    default:
      throw new TypeError('Run domain operation kind is invalid.');
  }
};
