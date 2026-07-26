import type { LifecycleCommitted } from './lifecycle-committed.js';
import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';
import type { LifecyclePreparedReconcileCall } from './lifecycle-prepared-reconcile-call.js';
import type { LifecycleReconciliationReplayReceipt } from './lifecycle-reconciliation-replay-receipt.js';
import type { LifecycleReplayed } from './lifecycle-replayed.js';

export type LifecyclePrepareReconciliationResult =
  | LifecycleCommitted<LifecyclePreparedReconcileCall>
  | LifecycleReplayed<LifecycleReconciliationReplayReceipt>
  | LifecycleConflictResult
  | LifecycleFaultResult;
