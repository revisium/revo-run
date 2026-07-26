import type { LifecycleExecuteObservation } from './lifecycle-execute-observation.js';

export interface LifecyclePreparedExecuteCapability {
  readonly invoke: (signal: AbortSignal) => Promise<LifecycleExecuteObservation>;
}
