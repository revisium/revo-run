import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleClaimReceipt {
  readonly authority: LifecycleAttemptAuthority & {
    readonly attemptPhase: 'claimed';
    readonly nodePhase: 'executing';
  };
  readonly ordinal: number;
}
