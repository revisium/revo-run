import type { DomainTransition, RunProgressionAppliedReceipt } from '../domain/index.js';
import type { RunStoreProgressionExpectations } from './run-store-progression-expectations.js';
import type { RunStoreProgressionIdempotencyWrite } from './run-store-progression-idempotency-write.js';
import type { RunStoreProgressionTrigger } from './run-store-progression-trigger.js';

export interface RunStoreProgressionTransitionCommand {
  readonly kind: 'apply_progression_transition';
  readonly operation: RunProgressionAppliedReceipt['operation'];
  readonly trigger: RunStoreProgressionTrigger;
  readonly transition: DomainTransition;
  readonly expected: RunStoreProgressionExpectations;
  readonly idempotency: RunStoreProgressionIdempotencyWrite;
}
