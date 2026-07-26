import type { ExecutorInvocationSnapshot } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { snapshotExecutorAttemptReference } from './snapshot-executor-attempt-reference.js';
import { snapshotExecutorConfiguration } from './snapshot-executor-configuration.js';
import { snapshotExecutorContractPin } from './snapshot-executor-contract-pin.js';
import { snapshotPortableJsonValue } from './snapshot-portable-json-value.js';

export const snapshotExecutorInvocationSnapshot = (value: unknown): ExecutorInvocationSnapshot => {
  const record = contractValidation.snapshotRecord(value, [
    'activationContext',
    'attempt',
    'executorConfiguration',
    'executorConfigurationDigest',
    'executorContractPin',
    'runInput',
  ]);
  const configuration = snapshotExecutorConfiguration(record['executorConfiguration']);
  const suppliedDigest = contractValidation.executorConfigurationDigest(
    record['executorConfigurationDigest'],
  );
  if (suppliedDigest !== configuration.digest) {
    throw new TypeError('Executor configuration digest does not match its complete snapshot.');
  }
  const snapshot: ExecutorInvocationSnapshot = Object.freeze({
    activationContext: contractValidation.requiredValue(record, 'activationContext'),
    attempt: snapshotExecutorAttemptReference(record['attempt']),
    executorConfiguration: configuration.configuration,
    executorConfigurationDigest: configuration.digest,
    executorContractPin: snapshotExecutorContractPin(record['executorContractPin']),
    runInput: contractValidation.requiredValue(record, 'runInput'),
  });
  snapshotPortableJsonValue(snapshot);
  return snapshot;
};
