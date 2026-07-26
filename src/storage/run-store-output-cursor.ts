export interface RunStoreOutputCursor {
  readonly runId: string;
  readonly nodeInstanceId: string | null;
  readonly attemptId: string | null;
  readonly activationId: string | null;
  readonly names: readonly string[];
  readonly lastOutputId: string;
}
