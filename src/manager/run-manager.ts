import type { ExecutionPlanPin, JsonValue, RunManagerSnapshot } from '../spec/index.js';

export interface RunManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  startRun(request: {
    readonly planPin: ExecutionPlanPin;
    readonly input: JsonValue;
  }): Promise<RunManagerSnapshot>;
  getRun(runId: string): Promise<RunManagerSnapshot | undefined>;
}
