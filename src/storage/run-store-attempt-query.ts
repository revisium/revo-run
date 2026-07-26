import type { RunStoreAttemptCursor } from './run-store-attempt-cursor.js';

export interface RunStoreAttemptQuery extends Omit<RunStoreAttemptCursor, 'lastAttemptId'> {
  readonly limit: number;
  readonly cursor: RunStoreAttemptCursor | null;
}
