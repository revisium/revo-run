import type { RunStoreDiscoveryCandidateBase } from './run-store-discovery-candidate-base.js';
import type { RunStoreObservedAttempt } from './run-store-observed-attempt.js';
import type { RunStoreObservedNode } from './run-store-observed-node.js';

export type RunStoreDiscoveryCandidate =
  | (RunStoreDiscoveryCandidateBase & {
      readonly kind: 'handoff_attempt';
      readonly observedNode: RunStoreObservedNode;
      readonly observedAttempt: RunStoreObservedAttempt;
      readonly handoffId: string;
    })
  | (RunStoreDiscoveryCandidateBase & {
      readonly kind: 'expired_attempt' | 'renewable_attempt' | 'retiring_attempt';
      readonly observedNode: RunStoreObservedNode;
      readonly observedAttempt: RunStoreObservedAttempt;
      readonly handoffId: null;
    })
  | (RunStoreDiscoveryCandidateBase & {
      readonly kind: 'claimable_node';
      readonly observedNode: RunStoreObservedNode;
      readonly observedAttempt: null;
      readonly handoffId: null;
    })
  | (RunStoreDiscoveryCandidateBase & {
      readonly kind: 'cancellation_run' | 'progressable_run';
      readonly observedNode: null;
      readonly observedAttempt: null;
      readonly handoffId: null;
    });
