import type { RunFault } from '../errors/index.js';
import type { ExecutionPlanPin, JsonValue, RunId } from '../spec/index.js';
import type { RunStatus } from './run-status.js';

export interface Run {
  readonly id: RunId;
  readonly planPin: ExecutionPlanPin;
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
