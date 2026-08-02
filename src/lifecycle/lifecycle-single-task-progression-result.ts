import type { Run, RunProgressionAppliedReceipt } from '../domain/index.js';
import type { RunConflict, RunFault } from '../errors/index.js';

export type LifecycleSingleTaskProgressionResult =
  | {
      readonly kind: 'committed' | 'replayed';
      readonly run: Run;
      readonly receipt: RunProgressionAppliedReceipt;
    }
  | { readonly kind: 'conflict'; readonly conflict: RunConflict }
  | { readonly kind: 'fault'; readonly fault: RunFault };
