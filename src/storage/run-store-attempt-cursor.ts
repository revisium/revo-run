import type { AttemptStatus } from '../domain/index.js';

export interface RunStoreAttemptCursor {
  readonly runId: string;
  readonly nodeInstanceId: string | null;
  readonly statuses: readonly AttemptStatus[];
  readonly managerIncarnationId: string | null;
  readonly lastAttemptId: string;
}
