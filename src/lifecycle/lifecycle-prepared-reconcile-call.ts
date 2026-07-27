import type { ExecutorInvocationSnapshot } from '../spec/index.js';
import type { LifecyclePreparedReconcileCapability } from './lifecycle-prepared-reconcile-capability.js';
import type { LifecycleReconcilingExecutionAuthority } from './lifecycle-reconciling-execution-authority.js';

export interface LifecyclePreparedReconcileCall {
  readonly kind: 'reconcile';
  readonly reconcile: LifecyclePreparedReconcileCapability;
  readonly invocation: ExecutorInvocationSnapshot;
  readonly authority: LifecycleReconcilingExecutionAuthority;
}
