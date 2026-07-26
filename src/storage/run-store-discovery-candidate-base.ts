import type { RunStoreObservedRun } from './run-store-observed-run.js';

export interface RunStoreDiscoveryCandidateBase {
  readonly eligibleAt: number;
  readonly observedRun: RunStoreObservedRun;
}
