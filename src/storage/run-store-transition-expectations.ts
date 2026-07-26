import type { RunStoreAttemptExpectation } from './run-store-attempt-expectation.js';
import type { RunStoreNewNodeExpectation } from './run-store-new-node-expectation.js';
import type { RunStoreNodeExpectation } from './run-store-node-expectation.js';
import type { RunStoreRunExpectation } from './run-store-run-expectation.js';

export interface RunStoreTransitionExpectations {
  readonly run: RunStoreRunExpectation;
  readonly nodes: readonly RunStoreNodeExpectation[];
  readonly attempts: readonly RunStoreAttemptExpectation[];
  readonly absentAttemptIds: readonly string[];
  readonly absentNodes: readonly RunStoreNewNodeExpectation[];
  readonly absentOutputIds: readonly string[];
}
