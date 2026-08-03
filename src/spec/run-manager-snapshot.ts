import type { ExecutionPlanPin } from './execution-plan-pin.js';
import type { JsonValue } from './json-value.js';
import type { RunManagerStatus } from './run-manager-status.js';

export interface RunManagerSnapshot {
  readonly id: string;
  readonly planPin: ExecutionPlanPin;
  readonly status: RunManagerStatus;
  readonly input: JsonValue;
  readonly result: JsonValue | null;
  readonly error: string | null;
}
