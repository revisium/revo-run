import type { RunEventCursor } from './run-event-cursor.js';
import type { RunStoreEvent } from './run-store-event.js';
import type { RunStoreIdempotencyRecord } from './run-store-idempotency-record.js';
import type { RunStoreTakeoverResult } from './run-store-takeover-result.js';

export interface RunStoreCommittedResult {
  readonly kind: 'committed';
  readonly transactionNow: number;
  readonly materializedEvents: readonly RunStoreEvent[];
  readonly cursor: RunEventCursor;
  readonly takeover: RunStoreTakeoverResult | null;
  readonly idempotency: RunStoreIdempotencyRecord | null;
}
