import type { AttemptHandoffKey } from './attempt-handoff-key.js';
import type { AttemptHandoffReason } from './attempt-handoff-reason.js';
import type { RunStoreAttemptExpectation } from './run-store-attempt-expectation.js';
import type { RunStoreIdempotencyWrite } from './run-store-idempotency-write.js';
import type { RunStoreIncumbentAuthority } from './run-store-incumbent-authority.js';
import type { RunStoreNodeExpectation } from './run-store-node-expectation.js';
import type { RunStoreRunExpectation } from './run-store-run-expectation.js';

export interface RunStoreWriteHandoffCommand {
  readonly kind: 'write_handoff';
  readonly handoffId: string;
  readonly reason: AttemptHandoffReason;
  readonly expected: {
    readonly run: RunStoreRunExpectation;
    readonly node: RunStoreNodeExpectation;
    readonly attempt: RunStoreAttemptExpectation & {
      readonly handoff: {
        readonly kind: 'absent';
        readonly key: AttemptHandoffKey;
      };
    };
  };
  readonly authority: RunStoreIncumbentAuthority;
  readonly idempotency: RunStoreIdempotencyWrite;
}
