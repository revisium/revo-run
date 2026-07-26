import type {
  ExecutionPlanPin,
  ExecutorConfigurationDigest,
  ExecutorContractPin,
} from '../spec/index.js';
import type { LifecycleActiveAttemptPhase } from './lifecycle-active-attempt-phase.js';
import type { LifecycleNodePhase } from './lifecycle-node-phase.js';

export interface LifecycleAttemptAuthority {
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly activationId: string;
  readonly nodeKey: string;
  readonly attemptId: string;
  readonly attemptPhase: LifecycleActiveAttemptPhase;
  readonly nodePhase: LifecycleNodePhase;
  readonly expectedRunRevision: number;
  readonly expectedNodeRevision: number;
  readonly expectedAttemptRevision: number;
  readonly managerIncarnationId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: number;
  readonly dispatchIdempotencyKey: string;
  readonly planPin: ExecutionPlanPin;
  readonly executorContractPin: ExecutorContractPin;
  readonly executorConfigurationDigest: ExecutorConfigurationDigest;
}
