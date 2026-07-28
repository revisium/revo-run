import type { RunStoreNewNodeExpectation } from './run-store-new-node-expectation.js';
import type { RunStoreTransitionExpectations } from './run-store-transition-expectations.js';

export type RunStoreProgressionExpectations =
  | {
      readonly kind: 'create';
      readonly absentRunId: string;
      readonly absentNodes: readonly RunStoreNewNodeExpectation[];
      readonly absentOutputIds: readonly string[];
    }
  | { readonly kind: 'transition'; readonly value: RunStoreTransitionExpectations };
