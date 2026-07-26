import type { RunStoreAttemptCorrelation } from './run-store-attempt-correlation.js';
import type { RunStoreOwnershipPayloadBase } from './run-store-ownership-payload-base.js';

export type RunStoreOwnershipAcquiredEventIntent =
  | {
      readonly runId: string;
      readonly kind: 'attempt.ownership_acquired';
      readonly correlation: RunStoreAttemptCorrelation;
      readonly payload: RunStoreOwnershipPayloadBase & {
        readonly evidence: 'lease_expired';
        readonly handoffId: null;
      };
    }
  | {
      readonly runId: string;
      readonly kind: 'attempt.ownership_acquired';
      readonly correlation: RunStoreAttemptCorrelation;
      readonly payload: RunStoreOwnershipPayloadBase & {
        readonly evidence: 'handoff';
        readonly handoffId: string;
      };
    };
