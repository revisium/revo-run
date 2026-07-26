import type { AttemptHandoffKey } from './attempt-handoff-key.js';

export type RunStoreHandoffExpectation =
  | { readonly kind: 'absent'; readonly key: AttemptHandoffKey }
  | {
      readonly kind: 'named';
      readonly key: AttemptHandoffKey;
      readonly handoffId: string;
    };
