import type { LifecycleExecuteObservation } from './lifecycle-execute-observation.js';
import type { LifecycleStartedExecutionAuthority } from './lifecycle-started-execution-authority.js';

export interface LifecycleProcessExecuteObservationRequest {
  readonly authority: LifecycleStartedExecutionAuthority;
  readonly generatedOutputIds: readonly string[];
  readonly idempotencyKey: string;
  readonly observation: LifecycleExecuteObservation;
}
