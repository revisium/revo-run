import type { ExecutorInvocationSnapshot } from '../spec/index.js';

export interface ExecutorExecuteRequest {
  readonly operation: 'execute';
  readonly invocation: ExecutorInvocationSnapshot;
  readonly signal: AbortSignal;
}
