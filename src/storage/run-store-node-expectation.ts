export interface RunStoreNodeExpectation {
  readonly nodeInstanceId: string;
  readonly revision: number;
  readonly activeAttemptId: string | null;
}
