import type { LifecycleActiveAttemptPhase } from './lifecycle-active-attempt-phase.js';

export interface LifecycleObservedAttempt {
  readonly attemptId: string;
  readonly attemptRevision: number;
  readonly attemptPhase: LifecycleActiveAttemptPhase;
  readonly managerIncarnationId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: number;
}
