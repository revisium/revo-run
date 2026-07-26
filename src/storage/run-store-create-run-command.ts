import type { Run, RunEventIntent, RunNodeInstance, RunOutput } from '../domain/index.js';
import type { RunStoreIdempotencyWrite } from './run-store-idempotency-write.js';
import type { RunStoreNewNodeExpectation } from './run-store-new-node-expectation.js';

export interface RunStoreCreateRunCommand {
  readonly kind: 'create_run';
  readonly run: Run;
  readonly nodes: readonly RunNodeInstance[];
  readonly outputs: readonly RunOutput[];
  readonly eventIntents: readonly RunEventIntent[];
  readonly expected: {
    readonly absentRunId: string;
    readonly absentNodes: readonly RunStoreNewNodeExpectation[];
    readonly absentOutputIds: readonly string[];
  };
  readonly idempotency: RunStoreIdempotencyWrite;
}
