import type { ExecutionPlanPin } from '../spec/index.js';

export interface RunStoreRunExpectation {
  readonly runId: string;
  readonly revision: number;
  readonly planPin: ExecutionPlanPin;
}
