import type { ExecutionPlanPin, JsonValue } from '../spec/index.js';

export interface RunPlanSource {
  loadExact(pin: ExecutionPlanPin): Promise<{
    readonly compiledPipeline: JsonValue;
    readonly taskInputs?: Readonly<Record<string, JsonValue>>;
  }>;
}
