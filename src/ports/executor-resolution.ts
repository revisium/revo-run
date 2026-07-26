import type { ExecutorUnavailableFault } from '../errors/index.js';
import type { ResolvedExecutor } from './resolved-executor.js';

export type ExecutorResolution =
  | { readonly kind: 'resolved'; readonly executor: ResolvedExecutor }
  | { readonly kind: 'unavailable'; readonly fault: ExecutorUnavailableFault };
