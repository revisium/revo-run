import type { LeasePolicy } from '../spec/index.js';
import type { LifecycleDiscoveryKey } from './lifecycle-discovery-key.js';
import type { LifecycleDiscoveryKind } from './lifecycle-discovery-kind.js';

export interface LifecycleDiscoveryCursor {
  readonly kinds: readonly LifecycleDiscoveryKind[];
  readonly renewal: {
    readonly managerIncarnationId: string;
    readonly leasePolicy: LeasePolicy;
  } | null;
  readonly highWatermark: number;
  readonly last: LifecycleDiscoveryKey;
}
