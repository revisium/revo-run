import type { RunStoreDiscoveryKind } from './run-store-discovery-kind.js';
import type { RunStoreDiscoveryScan } from './run-store-discovery-scan.js';
import type { RunStoreRenewalDiscovery } from './run-store-renewal-discovery.js';

export interface RunStoreDiscoveryQuery {
  readonly kinds: readonly RunStoreDiscoveryKind[];
  readonly renewal: RunStoreRenewalDiscovery | null;
  readonly limit: number;
  readonly scan: RunStoreDiscoveryScan;
}
