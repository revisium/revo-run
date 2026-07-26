import type { ExecutorAttemptReference } from '../spec/index.js';
import { contractValidation } from './contract-validation.js';

export const snapshotExecutorAttemptReference = (value: unknown): ExecutorAttemptReference => {
  const record = contractValidation.snapshotRecord(value, [
    'activationId',
    'attemptId',
    'dispatchIdempotencyKey',
    'nodeInstanceId',
    'nodeKey',
    'runId',
  ]);
  return Object.freeze({
    activationId: contractValidation.boundedString(record['activationId'], 256),
    attemptId: contractValidation.boundedString(record['attemptId'], 256),
    dispatchIdempotencyKey: contractValidation.boundedString(record['dispatchIdempotencyKey'], 256),
    nodeInstanceId: contractValidation.boundedString(record['nodeInstanceId'], 256),
    nodeKey: contractValidation.boundedString(record['nodeKey'], 256),
    runId: contractValidation.boundedString(record['runId'], 256),
  });
};
