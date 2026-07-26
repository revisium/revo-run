export interface LifecyclePreparedExecuteCapability {
  readonly invoke: (signal: AbortSignal) => Promise<unknown>;
}
