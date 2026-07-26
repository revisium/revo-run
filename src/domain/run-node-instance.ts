import type { RunFault } from '../errors/index.js';
import type {
  ActivationKey,
  AttemptId,
  BranchKey,
  ForkScopeKey,
  JsonValue,
  RunActivationId,
  RunId,
  RunNodeInstanceId,
} from '../spec/index.js';
import type { RunNodeStatus } from './run-node-status.js';

export interface RunNodeInstance {
  readonly id: RunNodeInstanceId;
  readonly runId: RunId;
  readonly nodeKey: string;
  readonly activationId: RunActivationId;
  readonly activationKey: ActivationKey;
  readonly parentActivationId: RunActivationId | null;
  readonly forkScopeKey: ForkScopeKey;
  readonly branchKey: BranchKey | null;
  readonly iteration: number;
  readonly activationContext: JsonValue;
  readonly status: RunNodeStatus;
  readonly revision: number;
  readonly activeAttemptId: AttemptId | null;
  readonly retryAvailableAt: number | null;
  readonly terminalFault: RunFault | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
}
