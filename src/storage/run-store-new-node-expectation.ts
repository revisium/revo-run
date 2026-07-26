import type { ActivationKey, ForkScopeKey } from '../spec/index.js';

export interface RunStoreNewNodeExpectation {
  readonly nodeInstanceId: string;
  readonly runId: string;
  readonly activationId: string;
  readonly forkScopeKey: ForkScopeKey;
  readonly activationKey: ActivationKey;
}
