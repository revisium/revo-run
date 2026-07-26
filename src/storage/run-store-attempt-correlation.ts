export interface RunStoreAttemptCorrelation {
  readonly kind: 'attempt';
  readonly nodeInstanceId: string;
  readonly activationId: string;
  readonly attemptId: string;
}
