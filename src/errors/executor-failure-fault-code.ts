import type { RunFaultCode } from './run-fault-code.js';

export type ExecutorFailureFaultCode = Exclude<
  RunFaultCode,
  | 'CANCELLED'
  | 'UNKNOWN_OUTCOME'
  | 'NOT_FOUND'
  | 'PLAN_INVALID'
  | 'PROGRESSION_STATE_INVALID'
  | 'PROGRESSION_COMMAND_CONFLICT'
  | 'PROGRESSION_LIMIT'
  | 'PROGRESSION_INVARIANT'
  | 'PIPELINE_TERMINAL'
>;
