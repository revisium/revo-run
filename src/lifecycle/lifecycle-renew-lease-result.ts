import type { LifecycleCommitted } from './lifecycle-committed.js';
import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';
import type { LifecycleRenewLeaseReceipt } from './lifecycle-renew-lease-receipt.js';

export type LifecycleRenewLeaseResult =
  | LifecycleCommitted<LifecycleRenewLeaseReceipt>
  | LifecycleConflictResult
  | LifecycleFaultResult;
