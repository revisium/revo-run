import type { RunStoreRunCursor } from './run-store-run-cursor.js';

export type RunStoreRunScan =
  | { readonly kind: 'start' }
  | { readonly kind: 'continue'; readonly cursor: RunStoreRunCursor };
