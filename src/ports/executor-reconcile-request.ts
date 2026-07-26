import type { ExecutorInvocationSnapshot } from '../spec/index.js';

export interface ExecutorReconcileRequest {
  readonly operation: 'reconcile';
  readonly invocation: ExecutorInvocationSnapshot;
  readonly signal: AbortSignal;
}
