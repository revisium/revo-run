import type { RunFault } from './run-fault.js';

export interface ExecutorUnknownOutcomeFault extends Omit<RunFault, 'code'> {
  readonly code: 'UNKNOWN_OUTCOME';
}
