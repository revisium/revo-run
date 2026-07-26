export interface RunStoreObservedNode {
  readonly nodeInstanceId: string;
  readonly nodeRevision: number;
  readonly activeAttemptId: string | null;
}
