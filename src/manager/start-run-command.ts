import type { ExecutionPlanPin, JsonValue } from '../spec/index.js';

export interface StartRunCommand {
  readonly plan: ExecutionPlanPin;
  readonly idempotencyKey: string;
  readonly input: JsonValue;
}
