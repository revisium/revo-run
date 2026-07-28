import type { RunFault } from '../errors/index.js';
import type { ExecutionPlanPin, JsonValue } from '../spec/index.js';
import type { RunProgressionState } from './run-progression-state.js';
import type { RunStatus } from './run-status.js';

export interface Run {
  readonly id: string;
  readonly planPin: ExecutionPlanPin;
  readonly progression: RunProgressionState;
  readonly status: RunStatus;
  readonly revision: number;
  readonly input: JsonValue;
  readonly metadata?: JsonValue;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cancellationRequestedAt: number | null;
  readonly terminalAt: number | null;
  readonly terminalFault: RunFault | null;
}
