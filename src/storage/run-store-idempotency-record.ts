import type { RunEventCursor } from './run-event-cursor.js';
import type { RunStoreIdempotencyWrite } from './run-store-idempotency-write.js';

export interface RunStoreIdempotencyRecord extends RunStoreIdempotencyWrite {
  readonly committedAt: number;
  readonly cursor: RunEventCursor;
}
