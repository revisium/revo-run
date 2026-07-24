export interface LeasePolicy {
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
}
