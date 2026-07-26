import type { RunFault } from '../errors/index.js';
import type { ActivationKey, ForkScopeKey, JsonValue } from '../spec/index.js';
import type { RunNodeStatus } from './run-node-status.js';

export interface RunNodeInstance {
  readonly id: string;
  readonly runId: string;
  readonly nodeKey: string;
  readonly activationId: string;
  readonly activationKey: ActivationKey;
  readonly parentActivationId: string | null;
  readonly forkScopeKey: ForkScopeKey;
  readonly branchKey: string | null;
  readonly iteration: number;
  readonly activationContext: JsonValue;
  readonly status: RunNodeStatus;
  readonly revision: number;
  readonly activeAttemptId: string | null;
  readonly retryAvailableAt: number | null;
  readonly terminalFault: RunFault | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
}
