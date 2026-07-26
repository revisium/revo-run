export interface LifecycleAcquireReplayReceipt {
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly attemptId: string;
  readonly successorManagerIncarnationId: string;
  readonly successorFencingToken: number;
  readonly recovery: 'start' | 'reconcile';
}
