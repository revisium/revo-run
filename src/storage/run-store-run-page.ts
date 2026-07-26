import type { Run } from '../domain/index.js';
import type { RunStoreRunCursor } from './run-store-run-cursor.js';

export interface RunStoreRunPage {
  readonly items: readonly Run[];
  readonly highWatermark: number;
  readonly next: RunStoreRunCursor | null;
}
