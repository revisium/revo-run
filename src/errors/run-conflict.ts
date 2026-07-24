import type { RunConflictCode } from './run-conflict-code.js';

export interface RunConflict {
  readonly code: RunConflictCode;
  readonly message: string;
}
