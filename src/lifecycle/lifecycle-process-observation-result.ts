import type { LifecycleCommitted } from './lifecycle-committed.js';
import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';
import type { LifecycleObservationReceipt } from './lifecycle-observation-receipt.js';
import type { LifecycleReplayed } from './lifecycle-replayed.js';
import type { LifecycleRequiresProgression } from './lifecycle-requires-progression.js';

export type LifecycleProcessObservationResult =
  | LifecycleCommitted<LifecycleObservationReceipt>
  | LifecycleReplayed<LifecycleObservationReceipt>
  | LifecycleRequiresProgression
  | LifecycleConflictResult
  | LifecycleFaultResult;
