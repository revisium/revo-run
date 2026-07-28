import type { RunFault } from '../errors/index.js';
import type { ExecutorConfigurationDigest, ExecutorContractPin } from '../spec/index.js';
import type { AttemptStatus } from './attempt-status.js';

export interface Attempt {
  readonly id: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly ordinal: number;
  readonly status: AttemptStatus;
  readonly revision: number;
  readonly ownerLabel: string;
  readonly managerIncarnationId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: number;
  readonly lastHeartbeatAt: number;
  readonly dispatchIdempotencyKey: string;
  readonly executorContractPin: ExecutorContractPin;
  readonly executorConfigurationDigest: ExecutorConfigurationDigest;
  readonly fault: RunFault | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startCommittedAt: number | null;
  readonly progressionClosedAt: number | null;
  readonly terminalAt: number | null;
}
