import type { LifecycleActiveAttemptPhase } from './lifecycle-active-attempt-phase.js';

export interface LifecycleHydrateOwnedAuthorityRequest {
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly attemptId: string;
  readonly expectedManagerIncarnationId: string;
  readonly expectedAttemptFence: number;
  readonly expectedPhase: LifecycleActiveAttemptPhase;
}
