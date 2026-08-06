import type { JsonValue } from '../json-value.js';
import type { NodeOutput } from '../pipeline/node-output.js';
import type { ExecutionPlan } from './execution-plan.js';

// RunSnapshot is an in-memory manager view, not a durable JSON contract. Serialized API models
// must define their own timestamp representation and schema instead of reusing this Date-based view.
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunError {
  readonly code: string;
  readonly message: string;
}

export interface RunResult {
  readonly outcome: string;
  readonly output?: NodeOutput;
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
