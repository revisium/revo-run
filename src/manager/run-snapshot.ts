import type { RunFault } from '../errors/index.js';
import type { ExecutionPlanPin, JsonValue } from '../spec/index.js';

export interface RunSnapshot {
  readonly id: string;
  readonly plan: ExecutionPlanPin;
  readonly status: 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  readonly input: JsonValue;
  readonly terminalFault: RunFault | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
}
