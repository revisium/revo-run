import type { RunNodeStatus } from './run-node-status.js';

export const isRunNodeStatusTransitionAllowed = (
  from: RunNodeStatus,
  to: RunNodeStatus,
): boolean => {
  switch (from) {
    case 'ready':
      return to === 'executing' || to === 'cancelled' || to === 'retired';
    case 'executing':
      return (
        to === 'succeeded' ||
        to === 'failed' ||
        to === 'retry_waiting' ||
        to === 'unknown' ||
        to === 'cancelled' ||
        to === 'retiring' ||
        to === 'retired'
      );
    case 'retry_waiting':
      return to === 'executing' || to === 'cancelled' || to === 'retired';
    case 'unknown':
      return (
        to === 'executing' ||
        to === 'succeeded' ||
        to === 'failed' ||
        to === 'retry_waiting' ||
        to === 'cancelled' ||
        to === 'retiring'
      );
    case 'gate_waiting':
      return to === 'succeeded' || to === 'cancelled' || to === 'retired';
    case 'join_waiting':
      return to === 'ready' || to === 'succeeded' || to === 'cancelled' || to === 'retired';
    case 'selector_waiting':
      return to === 'succeeded' || to === 'cancelled' || to === 'retired';
    case 'retiring':
      return to === 'retired';
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'skipped':
    case 'retired':
      return false;
  }
  throw new TypeError('Run node status is invalid.');
};
