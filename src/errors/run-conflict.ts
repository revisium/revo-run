import type { RunFaultMessage } from '../spec/index.js';
import type { RunConflictCode } from './run-conflict-code.js';

export interface RunConflict {
  readonly code: RunConflictCode;
  readonly message: RunFaultMessage;
}
