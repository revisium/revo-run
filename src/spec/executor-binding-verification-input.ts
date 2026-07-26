import type { ExecutorConfigurationDigest } from './executor-configuration-digest.js';
import type { ExecutorContractPin } from './executor-contract-pin.js';
import type { JsonValue } from './json-value.js';

export interface ExecutorBindingVerificationInput {
  readonly binding: {
    readonly executor: ExecutorContractPin;
    readonly configuration: JsonValue;
    readonly configurationDigest: ExecutorConfigurationDigest;
    readonly idempotentExecution?: boolean;
  };
  readonly attempt: {
    readonly executorContractPin: ExecutorContractPin;
    readonly executorConfigurationDigest: ExecutorConfigurationDigest;
  };
  readonly resolvedExecutorContractPin: ExecutorContractPin;
}
