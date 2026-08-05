import type { JsonValue } from '@revisium/revo-pipeline';

import type { ExecutionPlan } from './execution-plan.js';

export interface StartRunInput {
  readonly runId: string;
  readonly executionPlan: ExecutionPlan;
  readonly input: JsonValue;
}

export interface StartRunResult {
  readonly runId: string;
}
