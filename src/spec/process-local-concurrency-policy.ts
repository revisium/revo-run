export interface ProcessLocalConcurrencyPolicy {
  readonly maximumConcurrentExecutions: number;
  readonly maximumConcurrentExecutionsPerExecutor: number;
}
