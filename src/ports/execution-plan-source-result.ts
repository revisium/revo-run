import type { ExecutionPlanSourceFault } from '../errors/index.js';
import type { RunExecutionPlanDocument } from '../spec/index.js';

export type ExecutionPlanSourceResult =
  | { readonly kind: 'loaded'; readonly planDocument: RunExecutionPlanDocument }
  | { readonly kind: 'fault'; readonly fault: ExecutionPlanSourceFault };
