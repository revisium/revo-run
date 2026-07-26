import type { RunStatus } from '../domain/index.js';
import type { RunStoreRunScan } from './run-store-run-scan.js';

export interface RunStoreListRunsQuery {
  readonly statuses: readonly RunStatus[];
  readonly planId: string | null;
  readonly limit: number;
  readonly scan: RunStoreRunScan;
}
