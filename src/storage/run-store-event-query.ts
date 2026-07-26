import type { RunStoreEventScan } from './run-store-event-scan.js';

export interface RunStoreEventQuery {
  readonly runId: string;
  readonly limit: number;
  readonly scan: RunStoreEventScan;
}
