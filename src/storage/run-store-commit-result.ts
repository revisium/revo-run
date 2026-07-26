import type { RunConflict } from '../errors/index.js';
import type { RunStoreCommittedResult } from './run-store-committed-result.js';
import type { RunStoreIdempotencyRecord } from './run-store-idempotency-record.js';
import type { RunStoreInvalidInput } from './run-store-invalid-input.js';

export type RunStoreCommitResult =
  | RunStoreCommittedResult
  | { readonly kind: 'replayed'; readonly record: RunStoreIdempotencyRecord }
  | { readonly kind: 'conflict'; readonly conflict: RunConflict }
  | { readonly kind: 'invalid_input'; readonly fault: RunStoreInvalidInput };
