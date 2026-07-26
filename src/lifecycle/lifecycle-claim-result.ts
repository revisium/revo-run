import type { LifecycleClaimReceipt } from './lifecycle-claim-receipt.js';
import type { LifecycleClaimReplayReceipt } from './lifecycle-claim-replay-receipt.js';
import type { LifecycleCommitted } from './lifecycle-committed.js';
import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';
import type { LifecycleReplayed } from './lifecycle-replayed.js';

export type LifecycleClaimResult =
  | LifecycleCommitted<LifecycleClaimReceipt>
  | LifecycleReplayed<LifecycleClaimReplayReceipt>
  | LifecycleConflictResult
  | LifecycleFaultResult;
