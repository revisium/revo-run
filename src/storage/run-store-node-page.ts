import type { RunNodeInstance } from '../domain/index.js';
import type { RunStoreNodeCursor } from './run-store-node-cursor.js';

export interface RunStoreNodePage {
  readonly items: readonly RunNodeInstance[];
  readonly next: RunStoreNodeCursor | null;
}
