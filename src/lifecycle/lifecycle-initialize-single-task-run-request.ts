import type { RunExecutionPlanDocument, JsonValue } from '../spec/index.js';

export interface LifecycleInitializeSingleTaskRunRequest {
  readonly planDocument: RunExecutionPlanDocument;
  readonly runId: string;
  readonly occurrenceKey: string;
  readonly allocationSeed: string;
  readonly idempotencyKey: string;
  readonly input: JsonValue;
}
