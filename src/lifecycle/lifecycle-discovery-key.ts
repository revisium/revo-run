import type { LifecycleDiscoveryKind } from './lifecycle-discovery-kind.js';

export interface LifecycleDiscoveryKey {
  readonly eligibleAt: number;
  readonly kind: LifecycleDiscoveryKind;
  readonly runId: string;
  readonly nodeInstanceId: string | null;
  readonly attemptId: string | null;
}
