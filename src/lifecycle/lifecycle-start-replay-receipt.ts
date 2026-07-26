export interface LifecycleStartReplayReceipt {
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly attemptId: string;
  readonly managerIncarnationId: string;
  readonly fencingToken: number;
  readonly attemptRevision: number;
  readonly attemptPhase: 'start_committed';
  readonly nodePhase: 'executing';
}
