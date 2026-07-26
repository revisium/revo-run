import type { DomainTransition } from '../domain/index.js';
import type { LeasePolicy } from '../spec/index.js';
import type { RunStoreIdempotencyWrite } from './run-store-idempotency-write.js';
import type { RunStoreNodeExpectation } from './run-store-node-expectation.js';
import type { RunStoreRunExpectation } from './run-store-run-expectation.js';

export interface RunStoreClaimAttemptCommand {
  readonly kind: 'claim_attempt';
  readonly operation: 'claim';
  readonly transition: DomainTransition;
  readonly leasePolicy: LeasePolicy;
  readonly expected: {
    readonly run: RunStoreRunExpectation;
    readonly node: RunStoreNodeExpectation;
    readonly absentAttemptId: string;
    readonly absentNodes: readonly [];
    readonly absentOutputIds: readonly [];
  };
  readonly idempotency: RunStoreIdempotencyWrite;
}
