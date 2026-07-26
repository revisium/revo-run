import type { LifecycleAcquireReceipt } from './lifecycle-acquire-receipt.js';
import type { LifecycleAcquireReplayReceipt } from './lifecycle-acquire-replay-receipt.js';
import type { LifecycleCommitted } from './lifecycle-committed.js';
import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';
import type { LifecycleReplayed } from './lifecycle-replayed.js';

export type LifecycleAcquireResult =
  | LifecycleCommitted<LifecycleAcquireReceipt>
  | LifecycleReplayed<LifecycleAcquireReplayReceipt>
  | LifecycleConflictResult
  | LifecycleFaultResult;
