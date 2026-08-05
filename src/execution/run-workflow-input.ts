import type { JsonValue } from '@revisium/revo-pipeline';

import type { ExecutionPlan } from '../run/execution-plan.js';

export interface RunWorkflowInput {
  readonly executionPlan: ExecutionPlan;
  readonly input: JsonValue;
}
