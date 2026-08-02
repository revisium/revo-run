import type { RunExecutionPlanDocument } from '../spec/index.js';

interface PlanSourceFault {
  readonly code: 'NOT_FOUND' | 'PLAN_MISMATCH' | 'PLAN_UNAVAILABLE';
  readonly message: string;
}

export type ExecutionPlanSourceResult =
  | { readonly kind: 'loaded'; readonly planDocument: RunExecutionPlanDocument }
  | { readonly kind: 'fault'; readonly fault: PlanSourceFault };
