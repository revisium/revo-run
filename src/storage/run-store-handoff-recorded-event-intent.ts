import type { AttemptHandoffReason } from './attempt-handoff-reason.js';
import type { RunStoreAttemptCorrelation } from './run-store-attempt-correlation.js';

export interface RunStoreHandoffRecordedEventIntent {
  readonly runId: string;
  readonly kind: 'attempt.handoff_recorded';
  readonly correlation: RunStoreAttemptCorrelation;
  readonly payload: {
    readonly handoffId: string;
    readonly incumbentManagerIncarnationId: string;
    readonly incumbentFencingToken: number;
    readonly reason: AttemptHandoffReason;
  };
}
