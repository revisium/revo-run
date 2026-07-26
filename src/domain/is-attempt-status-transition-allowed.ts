import type { AttemptStatus } from './attempt-status.js';

export const isAttemptStatusTransitionAllowed = (
  from: AttemptStatus,
  to: AttemptStatus,
): boolean => {
  switch (from) {
    case 'claimed':
      return to === 'start_committed' || to === 'failed' || to === 'cancelled';
    case 'start_committed':
      return to === 'unknown' || to === 'succeeded' || to === 'failed' || to === 'cancelled';
    case 'unknown':
      return to === 'reconciling' || to === 'succeeded' || to === 'failed' || to === 'cancelled';
    case 'reconciling':
      return (
        to === 'start_committed' ||
        to === 'unknown' ||
        to === 'succeeded' ||
        to === 'failed' ||
        to === 'cancelled'
      );
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return false;
  }
  throw new TypeError('Attempt status is invalid.');
};
