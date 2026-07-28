import type { RunStoreIncumbentAuthority } from './run-store-incumbent-authority.js';

export type RunStoreProgressionTrigger =
  | { readonly kind: 'run'; readonly runId: string }
  | {
      readonly kind: 'activation';
      readonly runId: string;
      readonly nodeInstanceId: string;
      readonly activationId: string;
    }
  | { readonly kind: 'incumbent_attempt'; readonly authority: RunStoreIncumbentAuthority };
