import type { RunEventCursor } from './run-event-cursor.js';
import type { RunStoreEventPageCursor } from './run-store-event-page-cursor.js';

export type RunStoreEventScan =
  | { readonly kind: 'start'; readonly after: RunEventCursor }
  | { readonly kind: 'continue'; readonly cursor: RunStoreEventPageCursor };
