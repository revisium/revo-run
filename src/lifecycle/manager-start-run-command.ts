import type { ExecutionPlanPin, JsonValue } from '../spec/index.js';

export interface ManagerStartRunCommand {
  readonly plan: ExecutionPlanPin;
  readonly idempotencyKey: string;
  readonly input: JsonValue;
}
