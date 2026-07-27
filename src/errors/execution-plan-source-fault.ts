import type { RunFault } from './run-fault.js';

export interface ExecutionPlanSourceFault extends Omit<RunFault, 'code'> {
  readonly code: 'NOT_FOUND' | 'PLAN_MISMATCH' | 'PLAN_UNAVAILABLE';
}
