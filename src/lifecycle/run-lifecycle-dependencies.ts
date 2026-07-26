import type { ExecutorResolver } from '../ports/index.js';
import type { RunStore } from '../storage/index.js';

export interface RunLifecycleDependencies {
  readonly executors: ExecutorResolver;
  readonly store: RunStore;
}
