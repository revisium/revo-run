export interface LifecycleHandoffReceipt {
  readonly handoffId: string;
  readonly attemptId: string;
  readonly incumbentFencingToken: number;
}
