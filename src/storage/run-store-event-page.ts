import type { RunEventCursor } from './run-event-cursor.js';
import type { RunStoreEventPageCursor } from './run-store-event-page-cursor.js';
import type { RunStoreEvent } from './run-store-event.js';

export interface RunStoreEventPage {
  readonly items: readonly RunStoreEvent[];
  readonly highWatermark: RunEventCursor;
  readonly next: RunStoreEventPageCursor | null;
}
