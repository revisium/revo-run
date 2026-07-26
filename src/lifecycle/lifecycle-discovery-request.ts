import type { LifecycleDiscoveryCursor } from './lifecycle-discovery-cursor.js';
import type { LifecycleDiscoveryKind } from './lifecycle-discovery-kind.js';

export interface LifecycleDiscoveryRequest {
  readonly kinds: readonly LifecycleDiscoveryKind[];
  readonly renewal: LifecycleDiscoveryCursor['renewal'];
  readonly limit: number;
  readonly scan:
    | { readonly kind: 'start' }
    | { readonly kind: 'continue'; readonly cursor: LifecycleDiscoveryCursor };
}
