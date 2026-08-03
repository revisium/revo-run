import type { RunExecutor, RunPlanSource, RunSnapshotStore } from '../../ports/index.js';

export interface RunWorkflowDependencies {
  readonly executor: RunExecutor;
  readonly plans: RunPlanSource;
  readonly snapshots: RunSnapshotStore;
}
