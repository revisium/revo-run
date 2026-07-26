export interface LifecycleClaimReplayReceipt {
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly attemptId: string;
  readonly ordinal: number;
  readonly fencingToken: 1;
}
