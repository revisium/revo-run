import type { LifecycleReconcileObservation } from './lifecycle-reconcile-observation.js';
import type { LifecycleReconcilingExecutionAuthority } from './lifecycle-reconciling-execution-authority.js';

export interface LifecycleProcessReconcileObservationRequest {
  readonly authority: LifecycleReconcilingExecutionAuthority;
  readonly generatedOutputIds: readonly string[];
  readonly idempotencyKey: string;
  readonly observation: LifecycleReconcileObservation;
}
