export interface RetryPolicy {
  readonly maximumAttempts: number;
  readonly initialBackoffMs: number;
  readonly maximumBackoffMs: number;
  readonly backoffMultiplier: number;
}
