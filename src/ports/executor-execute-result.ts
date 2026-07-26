import type { ExecutorUnknownOutcomeFault } from '../errors/index.js';
import type { ExecutorTerminalResult } from './executor-terminal-result.js';

export type ExecutorExecuteResult =
  | ExecutorTerminalResult
  | { readonly kind: 'unknown'; readonly fault: ExecutorUnknownOutcomeFault };
