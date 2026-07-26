import type { RunFault } from '../errors/index.js';
import type {
  AttemptId,
  ExecutorConfigurationDigest,
  ExecutorContractPin,
  FencingToken,
  ManagerIncarnationId,
  RunId,
  RunNodeInstanceId,
} from '../spec/index.js';
import type { AttemptStatus } from './attempt-status.js';

export interface Attempt {
  readonly id: AttemptId;
  readonly runId: RunId;
  readonly nodeInstanceId: RunNodeInstanceId;
  readonly ordinal: number;
  readonly status: AttemptStatus;
  readonly revision: number;
  readonly ownerLabel: string;
  readonly managerIncarnationId: ManagerIncarnationId;
  readonly fencingToken: FencingToken;
  readonly leaseExpiresAt: number;
  readonly lastHeartbeatAt: number;
  readonly dispatchIdempotencyKey: string;
  readonly executorContractPin: ExecutorContractPin;
  readonly executorConfigurationDigest: ExecutorConfigurationDigest;
  readonly fault: RunFault | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startCommittedAt: number | null;
  readonly terminalAt: number | null;
}
