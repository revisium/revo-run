import type { ExecutorConfigurationDigest } from './executor-configuration-digest.js';
import type { ExecutorContractPin } from './executor-contract-pin.js';
import type { JsonValue } from './json-value.js';

export interface VerifiedExecutorBinding {
  readonly executorContractPin: ExecutorContractPin;
  readonly executorConfiguration: JsonValue;
  readonly executorConfigurationDigest: ExecutorConfigurationDigest;
  readonly idempotentExecution: boolean;
}
