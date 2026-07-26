import type { LeasePolicy } from '../spec/index.js';
import type { RunStoreAttemptExpectation } from './run-store-attempt-expectation.js';
import type { RunStoreIdempotencyWrite } from './run-store-idempotency-write.js';
import type { RunStoreNodeExpectation } from './run-store-node-expectation.js';
import type { RunStoreRunExpectation } from './run-store-run-expectation.js';
import type { RunStoreTakeoverChange } from './run-store-takeover-change.js';
import type { RunStoreTakeoverEvidence } from './run-store-takeover-evidence.js';

export interface RunStoreAcquireAttemptCommand {
  readonly kind: 'acquire_attempt';
  readonly evidence: RunStoreTakeoverEvidence;
  readonly successorManagerIncarnationId: string;
  readonly leasePolicy: LeasePolicy;
  readonly change: RunStoreTakeoverChange;
  readonly expected: {
    readonly run: RunStoreRunExpectation;
    readonly node: RunStoreNodeExpectation;
    readonly attempt: RunStoreAttemptExpectation;
  };
  readonly idempotency: RunStoreIdempotencyWrite;
}
