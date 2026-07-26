import type { ExecutorUnknownOutcomeFault } from '../errors/index.js';
import type { ExecutorTerminalResult } from './executor-terminal-result.js';

export type ExecutorReconcileResult =
  | ExecutorTerminalResult
  | { readonly kind: 'running' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unknown'; readonly fault: ExecutorUnknownOutcomeFault };
