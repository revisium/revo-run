import type { RunExecutor, RunIdSource, RunPlanSource, RunSnapshotStore } from '../ports/index.js';

export interface CreateRunManagerOptions {
  readonly applicationName: string;
  /** Temporary local MVP configuration; remove before publish or deployment. */
  readonly systemDatabaseUrl: string;
  readonly executor: RunExecutor;
  readonly ids: RunIdSource;
  readonly plans: RunPlanSource;
  readonly snapshots: RunSnapshotStore;
}
