import type { LifecycleDiscoveryPage } from './lifecycle-discovery-page.js';
import type { LifecycleFaultResult } from './lifecycle-fault-result.js';

export type LifecycleDiscoveryResult =
  | { readonly kind: 'page'; readonly page: LifecycleDiscoveryPage }
  | LifecycleFaultResult;
