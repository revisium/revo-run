import type { ExecutorConfigurationDigest, ExecutorContractPin } from '../spec/index.js';

export interface RunStoreIncumbentAuthority {
  readonly attemptId: string;
  readonly expectedRunRevision: number;
  readonly expectedNodeRevision: number;
  readonly expectedAttemptRevision: number;
  readonly managerIncarnationId: string;
  readonly fencingToken: number;
  readonly executorContractPin: ExecutorContractPin;
  readonly executorConfigurationDigest: ExecutorConfigurationDigest;
}
