import type { ExecutorUnknownOutcomeFault } from '../errors/index.js';
import type { LifecycleKnownObservation } from './lifecycle-known-observation.js';

export type LifecycleExecuteObservation =
  | LifecycleKnownObservation
  | {
      readonly kind: 'unknown';
      readonly fault: ExecutorUnknownOutcomeFault;
    };
