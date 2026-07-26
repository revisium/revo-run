export interface LifecycleObservedNode {
  readonly nodeInstanceId: string;
  readonly nodeRevision: number;
  readonly activeAttemptId: string | null;
}
