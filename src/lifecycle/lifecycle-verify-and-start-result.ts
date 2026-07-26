import type { LifecycleCommitted } from './lifecycle-committed.js';
import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';
import type { LifecyclePreparedExecuteCall } from './lifecycle-prepared-execute-call.js';
import type { LifecycleReplayed } from './lifecycle-replayed.js';
import type { LifecycleStartReplayReceipt } from './lifecycle-start-replay-receipt.js';

export type LifecycleVerifyAndStartResult =
  | LifecycleCommitted<LifecyclePreparedExecuteCall>
  | LifecycleReplayed<LifecycleStartReplayReceipt>
  | LifecycleConflictResult
  | LifecycleFaultResult;
