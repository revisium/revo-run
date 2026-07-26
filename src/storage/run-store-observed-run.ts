import type { ExecutionPlanPin } from '../spec/index.js';

export interface RunStoreObservedRun {
  readonly runId: string;
  readonly runRevision: number;
  readonly planPin: ExecutionPlanPin;
}
