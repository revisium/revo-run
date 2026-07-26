import type { ExecutorFailureFaultCode } from './executor-failure-fault-code.js';
import type { RunFault } from './run-fault.js';

export interface ExecutorFailureFault extends Omit<RunFault, 'code'> {
  readonly code: ExecutorFailureFaultCode;
}
