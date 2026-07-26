import type { LeasePolicy } from '../spec/index.js';
import type { RunStoreIncumbentTransitionBase } from './run-store-incumbent-transition-base.js';

export interface RunStoreRenewLeaseTransitionCommand extends RunStoreIncumbentTransitionBase {
  readonly operation: 'renew_lease';
  readonly leasePolicy: LeasePolicy;
  readonly idempotency: null;
}
