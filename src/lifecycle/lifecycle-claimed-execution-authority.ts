import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleClaimedExecutionAuthority extends LifecycleAttemptAuthority {
  readonly attemptPhase: 'claimed';
  readonly nodePhase: 'executing';
}
