import type { ExecutorAttemptReference } from './executor-attempt-reference.js';
import type { ExecutorConfigurationDigest } from './executor-configuration-digest.js';
import type { ExecutorContractPin } from './executor-contract-pin.js';
import type { JsonValue } from './json-value.js';

export interface ExecutorInvocationSnapshot {
  readonly attempt: ExecutorAttemptReference;
  readonly executorContractPin: ExecutorContractPin;
  readonly executorConfiguration: JsonValue;
  readonly executorConfigurationDigest: ExecutorConfigurationDigest;
  readonly runInput: JsonValue;
  readonly activationContext: JsonValue;
}
