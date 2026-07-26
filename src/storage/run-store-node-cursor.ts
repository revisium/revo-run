import type { RunNodeStatus } from '../domain/index.js';
import type { ForkScopeKey } from '../spec/index.js';

export interface RunStoreNodeCursor {
  readonly runId: string;
  readonly statuses: readonly RunNodeStatus[];
  readonly forkScopeKey: ForkScopeKey | null;
  readonly nodeKeys: readonly string[];
  readonly lastNodeInstanceId: string;
}
