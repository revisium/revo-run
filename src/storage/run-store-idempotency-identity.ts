import type { RunStoreIdempotencyOperation } from './run-store-idempotency-operation.js';

export interface RunStoreIdempotencyIdentity {
  readonly operation: RunStoreIdempotencyOperation;
  readonly runId: string | null;
  readonly subjectId: string | null;
  readonly key: string;
}
