import type { RunExecutionPlanDocument } from '../spec/index.js';
import type { LifecycleAttemptAuthority } from './lifecycle-attempt-authority.js';
import type { LifecycleProgressionObservation } from './lifecycle-progression-observation.js';

export interface LifecycleProgressSingleTaskOutcomeRequest {
  readonly authority: LifecycleAttemptAuthority;
  readonly planDocument: RunExecutionPlanDocument;
  readonly observation: LifecycleProgressionObservation;
  readonly allocationSeed: string;
  readonly idempotencyKey: string;
}
