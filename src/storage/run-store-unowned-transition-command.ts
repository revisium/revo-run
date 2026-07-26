import type { DomainTransition } from '../domain/index.js';
import type { RunStoreIdempotencyWrite } from './run-store-idempotency-write.js';
import type { RunStoreTransitionExpectations } from './run-store-transition-expectations.js';
import type { RunStoreUnownedOperation } from './run-store-unowned-operation.js';

export interface RunStoreUnownedTransitionCommand {
  readonly kind: 'apply_unowned_transition';
  readonly operation: RunStoreUnownedOperation;
  readonly transition: DomainTransition;
  readonly expected: RunStoreTransitionExpectations;
  readonly idempotency: RunStoreIdempotencyWrite | null;
}
