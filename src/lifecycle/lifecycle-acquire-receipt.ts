import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleAcquireReceipt {
  readonly authority: LifecycleAttemptAuthority;
  readonly evidence:
    | { readonly kind: 'lease_expired' }
    | { readonly kind: 'handoff'; readonly handoffId: string };
  readonly recovery: 'start' | 'reconcile';
}
