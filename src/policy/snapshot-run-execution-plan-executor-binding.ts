import type { RunExecutionPlanExecutorBinding } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { snapshotExecutorConfiguration } from './snapshot-executor-configuration.js';
import { snapshotExecutorContractPin } from './snapshot-executor-contract-pin.js';
import { snapshotRetryPolicy } from './snapshot-retry-policy.js';
import { snapshotTimeoutPolicy } from './snapshot-timeout-policy.js';

export const snapshotRunExecutionPlanExecutorBinding = (
  value: unknown,
): RunExecutionPlanExecutorBinding => {
  const record = contractValidation.snapshotRecord(
    value,
    ['configuration', 'configurationDigest', 'executor', 'nodeKey', 'retryPolicy', 'timeoutPolicy'],
    ['idempotentExecution'],
  );
  const configuration = snapshotExecutorConfiguration(record['configuration']);
  if (record['configurationDigest'] !== configuration.digest) {
    throw new TypeError('Executor configuration digest does not match its complete snapshot.');
  }
  return Object.freeze({
    configuration: configuration.configuration,
    configurationDigest: configuration.digest,
    executor: snapshotExecutorContractPin(record['executor']),
    idempotentExecution: contractValidation.booleanWithDefault(
      record['idempotentExecution'],
      false,
    ),
    nodeKey: contractValidation.boundedString(record['nodeKey'], 256),
    retryPolicy: snapshotRetryPolicy(record['retryPolicy']),
    timeoutPolicy: snapshotTimeoutPolicy(record['timeoutPolicy']),
  });
};
