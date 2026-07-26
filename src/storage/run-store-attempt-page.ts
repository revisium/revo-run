import type { Attempt } from '../domain/index.js';
import type { RunStoreAttemptCursor } from './run-store-attempt-cursor.js';

export interface RunStoreAttemptPage {
  readonly items: readonly Attempt[];
  readonly next: RunStoreAttemptCursor | null;
}
