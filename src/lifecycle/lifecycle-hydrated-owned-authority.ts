import type { LifecycleActiveAttemptPhase } from './lifecycle-active-attempt-phase.js';
import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';

export interface LifecycleHydratedOwnedAuthority {
  readonly authority: LifecycleAttemptAuthority;
  readonly phase: LifecycleActiveAttemptPhase;
  readonly recovery: 'reconcile' | 'start';
}
