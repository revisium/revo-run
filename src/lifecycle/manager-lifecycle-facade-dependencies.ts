import type { ExecutionPlanSource, ExecutorResolver, ManagerIdSource } from '../ports/index.js';
import type { LeasePolicy } from '../spec/index.js';
import type { RunStore } from '../storage/index.js';

export interface ManagerLifecycleFacadeDependencies {
  readonly store: RunStore;
  readonly plans: ExecutionPlanSource;
  readonly executors: ExecutorResolver;
  readonly ids: ManagerIdSource;
  readonly coordination: {
    readonly ownerLabel: string;
    readonly leasePolicy: LeasePolicy;
  };
}
