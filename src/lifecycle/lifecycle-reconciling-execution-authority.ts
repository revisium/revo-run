import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleReconcilingExecutionAuthority extends LifecycleAttemptAuthority {
  readonly attemptPhase: 'reconciling';
  readonly nodePhase: 'unknown';
}
