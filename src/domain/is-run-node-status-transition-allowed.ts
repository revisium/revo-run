import type { RunNodeStatus } from './run-node-status.js';

export const isRunNodeStatusTransitionAllowed = (
  from: RunNodeStatus,
  to: RunNodeStatus,
): boolean => {
  switch (from) {
    case 'ready':
      return to === 'executing' || to === 'cancelled';
    case 'executing':
      return (
        to === 'succeeded' ||
        to === 'failed' ||
        to === 'retry_waiting' ||
        to === 'unknown' ||
        to === 'cancelled'
      );
    case 'retry_waiting':
      return to === 'executing' || to === 'cancelled';
    case 'unknown':
      return (
        to === 'executing' ||
        to === 'succeeded' ||
        to === 'failed' ||
        to === 'retry_waiting' ||
        to === 'cancelled'
      );
    case 'gate_waiting':
      return to === 'succeeded' || to === 'cancelled';
    case 'join_waiting':
      return to === 'ready' || to === 'succeeded' || to === 'cancelled';
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return false;
  }
  throw new TypeError('Run node status is invalid.');
};
