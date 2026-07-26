import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleRenewLeaseReceipt {
  readonly authority: LifecycleAttemptAuthority;
  readonly lastHeartbeatAt: number;
}
