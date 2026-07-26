import type { AttemptHandoffKey } from './attempt-handoff-key.js';
import type { RunStoreAttemptExpectation } from './run-store-attempt-expectation.js';
import type { RunStoreNewNodeExpectation } from './run-store-new-node-expectation.js';
import type { RunStoreNodeExpectation } from './run-store-node-expectation.js';
import type { RunStoreRunExpectation } from './run-store-run-expectation.js';

export interface RunStoreIncumbentTransitionExpected {
  readonly run: RunStoreRunExpectation;
  readonly nodes: readonly [RunStoreNodeExpectation];
  readonly attempts: readonly [
    RunStoreAttemptExpectation & {
      readonly handoff: {
        readonly kind: 'absent';
        readonly key: AttemptHandoffKey;
      };
    },
  ];
  readonly absentAttemptIds: readonly [];
  readonly absentNodes: readonly RunStoreNewNodeExpectation[];
  readonly absentOutputIds: readonly string[];
}
