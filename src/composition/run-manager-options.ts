import type { RunManagerExecutorsAdapter } from './run-manager-executors-adapter.js';
import type { RunManagerIdentifiersAdapter } from './run-manager-identifiers-adapter.js';
import type { RunManagerPersistenceAdapter } from './run-manager-persistence-adapter.js';
import type { RunManagerPlansAdapter } from './run-manager-plans-adapter.js';

export interface RunManagerOptions {
  readonly store: RunManagerPersistenceAdapter;
  readonly plans: RunManagerPlansAdapter;
  readonly executors: RunManagerExecutorsAdapter;
  readonly ids: RunManagerIdentifiersAdapter;
  readonly coordination?: {
    readonly ownerLabel?: string;
    readonly pollIntervalMs?: number;
    readonly heartbeatIntervalMs?: number;
    readonly leaseDurationMs?: number;
    readonly drainTimeoutMs?: number;
  };
}
