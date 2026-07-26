export interface ExecutorAttemptReference {
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly activationId: string;
  readonly nodeKey: string;
  readonly attemptId: string;
  readonly dispatchIdempotencyKey: string;
}
