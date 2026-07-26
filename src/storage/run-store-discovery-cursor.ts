import type { RunStoreDiscoveryKey } from './run-store-discovery-key.js';
import type { RunStoreDiscoveryKind } from './run-store-discovery-kind.js';
import type { RunStoreRenewalDiscovery } from './run-store-renewal-discovery.js';

export interface RunStoreDiscoveryCursor {
  readonly kinds: readonly RunStoreDiscoveryKind[];
  readonly renewal: RunStoreRenewalDiscovery | null;
  readonly highWatermark: number;
  readonly last: RunStoreDiscoveryKey;
}
