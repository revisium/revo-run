import type { ExecutionPlanPin } from '../spec/index.js';

export interface LifecycleObservedRun {
  readonly runId: string;
  readonly runRevision: number;
  readonly planPin: ExecutionPlanPin;
}
