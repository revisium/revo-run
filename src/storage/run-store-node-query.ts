import type { RunStoreNodeCursor } from './run-store-node-cursor.js';

export interface RunStoreNodeQuery extends Omit<RunStoreNodeCursor, 'lastNodeInstanceId'> {
  readonly limit: number;
  readonly cursor: RunStoreNodeCursor | null;
}
