import type { RunOutput } from '../domain/index.js';
import type { RunStoreOutputCursor } from './run-store-output-cursor.js';

export interface RunStoreOutputPage {
  readonly items: readonly RunOutput[];
  readonly next: RunStoreOutputCursor | null;
}
