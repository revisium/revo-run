import type { ExecutorInvocationSnapshot } from '../spec/index.js';

export interface ExecutorCancelRequest {
  readonly operation: 'cancel';
  readonly invocation: ExecutorInvocationSnapshot;
  readonly signal: AbortSignal;
}
