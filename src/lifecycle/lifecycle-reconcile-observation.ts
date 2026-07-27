import type { ExecutorUnknownOutcomeFault } from '../errors/index.js';
import type { LifecycleKnownObservation } from './lifecycle-known-observation.js';

export type LifecycleReconcileObservation =
  | LifecycleKnownObservation
  | {
      readonly kind: 'running';
    }
  | {
      readonly kind: 'unknown';
      readonly fault: ExecutorUnknownOutcomeFault;
    };
