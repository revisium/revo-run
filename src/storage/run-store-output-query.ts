import type { RunStoreOutputCursor } from './run-store-output-cursor.js';

export interface RunStoreOutputQuery extends Omit<RunStoreOutputCursor, 'lastOutputId'> {
  readonly limit: number;
  readonly cursor: RunStoreOutputCursor | null;
}
