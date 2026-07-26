export interface LifecycleReconciliationReplayReceipt {
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly attemptId: string;
  readonly managerIncarnationId: string;
  readonly fencingToken: number;
  readonly attemptRevision: number;
  readonly attemptPhase: 'reconciling';
  readonly nodePhase: 'unknown';
}
