import type { LeasePolicy } from '../spec/index.js';
import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleRenewLeaseRequest {
  readonly authority: LifecycleAttemptAuthority;
  readonly leasePolicy: LeasePolicy;
}
