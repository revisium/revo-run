import type { RunFaultCode } from './run-fault-code.js';

export type ExecutorFailureFaultCode = Exclude<
  RunFaultCode,
  'CANCELLED' | 'UNKNOWN_OUTCOME' | 'NOT_FOUND'
>;
