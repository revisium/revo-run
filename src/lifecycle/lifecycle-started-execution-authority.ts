import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleStartedExecutionAuthority extends LifecycleAttemptAuthority {
  readonly attemptPhase: 'start_committed';
  readonly nodePhase: 'executing';
}
