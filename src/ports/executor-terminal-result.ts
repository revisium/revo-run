import type { ExecutorFailureFault } from '../errors/index.js';
import type { ExecutorOutput } from '../spec/index.js';

export type ExecutorTerminalResult =
  | { readonly kind: 'succeeded'; readonly outputs: readonly ExecutorOutput[] }
  | { readonly kind: 'failed'; readonly fault: ExecutorFailureFault }
  | { readonly kind: 'cancelled' };
