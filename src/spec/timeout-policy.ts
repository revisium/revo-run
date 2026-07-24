export interface TimeoutPolicy {
  readonly executionTimeoutMs: number;
  readonly reconciliationTimeoutMs: number;
  readonly cancellationTimeoutMs: number;
}
