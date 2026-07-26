import type { RunFault } from './run-fault.js';

export interface ExecutorUnavailableFault extends Omit<RunFault, 'code'> {
  readonly code: 'EXECUTOR_UNAVAILABLE';
}
