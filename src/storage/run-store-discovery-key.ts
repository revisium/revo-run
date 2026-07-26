import type { RunStoreDiscoveryKind } from './run-store-discovery-kind.js';

export interface RunStoreDiscoveryKey {
  readonly eligibleAt: number;
  readonly kind: RunStoreDiscoveryKind;
  readonly runId: string;
  readonly nodeInstanceId: string | null;
  readonly attemptId: string | null;
}
