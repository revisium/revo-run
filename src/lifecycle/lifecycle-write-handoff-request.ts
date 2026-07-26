import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleWriteHandoffRequest {
  readonly authority: LifecycleAttemptAuthority;
  readonly generatedHandoffId: string;
  readonly reason: 'manager_shutdown' | 'manager_start_failure';
  readonly idempotencyKey: string;
}
