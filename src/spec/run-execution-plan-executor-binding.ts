import type { ExecutorConfigurationDigest } from './executor-configuration-digest.js';
import type { ExecutorContractPin } from './executor-contract-pin.js';
import type { JsonValue } from './json-value.js';
import type { RetryPolicy } from './retry-policy.js';
import type { TimeoutPolicy } from './timeout-policy.js';

export interface RunExecutionPlanExecutorBinding {
  readonly nodeKey: string;
  readonly executor: ExecutorContractPin;
  readonly configuration: JsonValue;
  readonly configurationDigest: ExecutorConfigurationDigest;
  readonly idempotentExecution: boolean;
  readonly retryPolicy: RetryPolicy;
  readonly timeoutPolicy: TimeoutPolicy;
}
