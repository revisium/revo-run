import type { LifecycleReconcileObservation } from './lifecycle-reconcile-observation.js';

export interface LifecyclePreparedReconcileCapability {
  readonly invoke: (signal: AbortSignal) => Promise<LifecycleReconcileObservation>;
}
