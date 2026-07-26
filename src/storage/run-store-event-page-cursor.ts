export interface RunStoreEventPageCursor {
  readonly runId: string;
  readonly afterSequence: number;
  readonly highWatermarkSequence: number;
}
