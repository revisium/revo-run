import type { AttemptTransitionPayload } from './attempt-transition-payload.js';
import type { Attempt } from './attempt.js';
import { domainEvents } from './domain-events.js';
import type { RunEventIntent } from './run-event-intent.js';
import type { RunNodeInstance } from './run-node-instance.js';

const payload = (prior: Attempt, next: Attempt): AttemptTransitionPayload | null => {
  if (prior.status === next.status) return null;
  if (prior.status === 'claimed' && next.status === 'cancelled') {
    return { cause: 'pre_start_cancellation', from: 'claimed', to: 'cancelled' };
  }
  if (prior.status === 'start_committed') {
    if (next.status === 'succeeded') {
      return { cause: 'direct_success', from: 'start_committed', to: 'succeeded' };
    }
    if (next.status === 'cancelled') {
      return { cause: 'direct_cancellation', from: 'start_committed', to: 'cancelled' };
    }
    if (next.status === 'failed' && next.fault !== null) {
      return {
        cause: 'direct_failure',
        faultCode: next.fault.code,
        from: 'start_committed',
        retryScheduled: false,
        to: 'failed',
      };
    }
  }
  if (prior.status === 'unknown') {
    if (next.status === 'succeeded')
      return { cause: 'late_success', from: 'unknown', to: 'succeeded' };
    if (next.status === 'cancelled') {
      return { cause: 'late_cancellation', from: 'unknown', to: 'cancelled' };
    }
    if (next.status === 'failed' && next.fault !== null) {
      return {
        cause: 'late_failure',
        faultCode: next.fault.code,
        from: 'unknown',
        retryScheduled: false,
        to: 'failed',
      };
    }
  }
  if (prior.status === 'reconciling') {
    if (next.status === 'succeeded') {
      return { cause: 'reconciled_success', from: 'reconciling', to: 'succeeded' };
    }
    if (next.status === 'cancelled') {
      return { cause: 'reconciled_cancellation', from: 'reconciling', to: 'cancelled' };
    }
    if (next.status === 'failed' && next.fault !== null) {
      return {
        cause: 'reconciled_failure',
        faultCode: next.fault.code,
        from: 'reconciling',
        retryScheduled: false,
        to: 'failed',
      };
    }
  }
  throw new TypeError('Run progression Attempt transition is invalid.');
};

export const deriveRunProgressionAttemptEvent = (input: {
  readonly prior: Attempt;
  readonly next: Attempt;
  readonly node: RunNodeInstance;
}): RunEventIntent | null => {
  const transition = payload(input.prior, input.next);
  return transition === null
    ? null
    : domainEvents.attemptTransitioned(input.node, input.next, transition);
};
