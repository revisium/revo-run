import type { LifecycleObservedAttempt } from './lifecycle-observed-attempt.js';
import type { LifecycleObservedNode } from './lifecycle-observed-node.js';
import type { LifecycleObservedRun } from './lifecycle-observed-run.js';

type Base = { readonly eligibleAt: number; readonly run: LifecycleObservedRun };
type AttemptCandidate = Base & {
  readonly node: LifecycleObservedNode & { readonly activeAttemptId: string };
  readonly attempt: LifecycleObservedAttempt;
};

export type LifecycleDiscoveryCandidate =
  | (Base & {
      readonly kind: 'claimable_node';
      readonly node: LifecycleObservedNode & { readonly activeAttemptId: null };
      readonly attempt: null;
      readonly handoffId: null;
    })
  | (AttemptCandidate & {
      readonly kind: 'expired_attempt';
      readonly handoffId: null;
    })
  | (AttemptCandidate & {
      readonly kind: 'renewable_attempt';
      readonly handoffId: null;
    })
  | (AttemptCandidate & { readonly kind: 'handoff_attempt'; readonly handoffId: string })
  | (Base & {
      readonly kind: 'cancellation_run';
      readonly node: null;
      readonly attempt: null;
      readonly handoffId: null;
    })
  | (Base & {
      readonly kind: 'progressable_run';
      readonly node: null;
      readonly attempt: null;
      readonly handoffId: null;
    });
