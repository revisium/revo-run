import type { LifecycleDiscoveryCandidate } from './lifecycle-discovery-candidate.js';
import type { LifecycleDiscoveryCursor } from './lifecycle-discovery-cursor.js';

export interface LifecycleDiscoveryPage {
  readonly items: readonly LifecycleDiscoveryCandidate[];
  readonly highWatermark: number;
  readonly next: LifecycleDiscoveryCursor | null;
}
