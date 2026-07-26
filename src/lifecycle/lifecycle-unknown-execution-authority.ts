import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleUnknownExecutionAuthority extends LifecycleAttemptAuthority {
  readonly attemptPhase: 'unknown';
  readonly nodePhase: 'unknown';
}
