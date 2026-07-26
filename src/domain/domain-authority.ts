import type {
  AttemptId,
  ExecutorConfigurationDigest,
  ExecutorContractPin,
  FencingToken,
  ManagerIncarnationId,
} from '../spec/index.js';

export interface DomainAuthority {
  readonly attemptId: AttemptId;
  readonly expectedRunRevision: number;
  readonly expectedNodeRevision: number;
  readonly expectedAttemptRevision: number;
  readonly managerIncarnationId: ManagerIncarnationId;
  readonly fencingToken: FencingToken;
  readonly executorContractPin: ExecutorContractPin;
  readonly executorConfigurationDigest: ExecutorConfigurationDigest;
  readonly transactionNow: number;
}
