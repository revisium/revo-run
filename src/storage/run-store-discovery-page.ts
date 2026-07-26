import type { RunStoreDiscoveryCandidate } from './run-store-discovery-candidate.js';
import type { RunStoreDiscoveryCursor } from './run-store-discovery-cursor.js';

export interface RunStoreDiscoveryPage {
  readonly items: readonly RunStoreDiscoveryCandidate[];
  readonly highWatermark: number;
  readonly next: RunStoreDiscoveryCursor | null;
}
