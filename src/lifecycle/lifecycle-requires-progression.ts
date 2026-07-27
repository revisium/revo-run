import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';
import type { LifecycleProgressionObservation } from './lifecycle-progression-observation.js';

export interface LifecycleRequiresProgression {
  readonly kind: 'requires_progression';
  readonly authority: LifecycleAttemptAuthority;
  readonly observation: LifecycleProgressionObservation;
}
