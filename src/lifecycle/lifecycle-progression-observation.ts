import type { ExecutorFailureFault } from '../errors/index.js';
import type { LifecycleProgressionOutput } from './lifecycle-progression-output.js';

export type LifecycleProgressionObservation =
  | {
      readonly kind: 'succeeded';
      readonly outputs: readonly LifecycleProgressionOutput[];
    }
  | {
      readonly kind: 'failed';
      readonly fault: ExecutorFailureFault;
    }
  | {
      readonly kind: 'cancelled';
    };
