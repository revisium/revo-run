import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleWriteHandoffRequest {
  readonly authority: LifecycleAttemptAuthority;
  readonly generatedHandoffId: string;
  readonly reason:
    | 'manager_progression_unavailable'
    | 'manager_recovery_failure'
    | 'manager_shutdown'
    | 'manager_start_failure';
  readonly idempotencyKey: string;
}
