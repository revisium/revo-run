import type { JsonValue } from '@revisium/revo-pipeline';

import type { ExecutionPlan } from './execution-plan.js';

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunError {
  readonly code: string;
  readonly message: string;
}

export interface RunResult {
  readonly outcome: string;
}

export interface RunSnapshot {
  readonly id: string;
  readonly status: RunStatus;
  readonly executionPlan: ExecutionPlan;
  readonly input: JsonValue;
  readonly result?: RunResult;
  readonly error?: RunError;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
