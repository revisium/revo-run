import type { RunStoreIdempotencyWrite } from './run-store-idempotency-write.js';
import type { RunStoreIncumbentTransitionBase } from './run-store-incumbent-transition-base.js';
import type { RunStoreNonRenewIncumbentOperation } from './run-store-non-renew-incumbent-operation.js';

export interface RunStoreNonRenewIncumbentTransitionCommand extends RunStoreIncumbentTransitionBase {
  readonly operation: RunStoreNonRenewIncumbentOperation;
  readonly leasePolicy?: never;
  readonly idempotency: RunStoreIdempotencyWrite;
}
