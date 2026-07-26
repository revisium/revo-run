import type { LifecycleCommitted } from './lifecycle-committed.js';
import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';
import type { LifecycleHandoffReceipt } from './lifecycle-handoff-receipt.js';
import type { LifecycleReplayed } from './lifecycle-replayed.js';

export type LifecycleWriteHandoffResult =
  | LifecycleCommitted<LifecycleHandoffReceipt>
  | LifecycleReplayed<LifecycleHandoffReceipt>
  | LifecycleConflictResult
  | LifecycleFaultResult;
