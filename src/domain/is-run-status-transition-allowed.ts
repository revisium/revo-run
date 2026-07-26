import type { RunStatus } from './run-status.js';

export const isRunStatusTransitionAllowed = (from: RunStatus, to: RunStatus): boolean => {
  switch (from) {
    case 'running':
      return to === 'cancelling' || to === 'succeeded' || to === 'failed' || to === 'cancelled';
    case 'cancelling':
      return to === 'succeeded' || to === 'failed' || to === 'cancelled';
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return false;
  }
  throw new TypeError('Run status is invalid.');
};
