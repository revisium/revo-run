import type { RunStatus } from '../domain/index.js';

export interface RunStoreRunCursor {
  readonly statuses: readonly RunStatus[];
  readonly planId: string | null;
  readonly highWatermark: number;
  readonly lastCreatedAt: number;
  readonly lastRunId: string;
}
