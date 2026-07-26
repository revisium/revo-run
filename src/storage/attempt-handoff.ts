import type { AttemptHandoffKey } from './attempt-handoff-key.js';
import type { AttemptHandoffReason } from './attempt-handoff-reason.js';

export interface AttemptHandoff {
  readonly id: string;
  readonly key: AttemptHandoffKey;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly activationId: string;
  readonly incumbentManagerIncarnationId: string;
  readonly expectedAttemptRevision: number;
  readonly reason: AttemptHandoffReason;
  readonly createdAt: number;
}
