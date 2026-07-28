export interface RunStoreObservedNode {
  readonly nodeInstanceId: string;
  readonly nodeKey: string;
  readonly nodeRevision: number;
  readonly activeAttemptId: string | null;
}
