import type { LifecycleConflictResult } from './lifecycle-conflict-result.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';
import type { LifecycleHydratedOwnedAuthority } from './lifecycle-hydrated-owned-authority.js';

export type LifecycleHydrateOwnedAuthorityResult =
  | {
      readonly kind: 'hydrated';
      readonly transactionNow: number;
      readonly value: LifecycleHydratedOwnedAuthority;
    }
  | LifecycleConflictResult
  | LifecycleFaultResult;
