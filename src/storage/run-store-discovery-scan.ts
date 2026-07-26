import type { RunStoreDiscoveryCursor } from './run-store-discovery-cursor.js';

export type RunStoreDiscoveryScan =
  | { readonly kind: 'start' }
  | { readonly kind: 'continue'; readonly cursor: RunStoreDiscoveryCursor };
