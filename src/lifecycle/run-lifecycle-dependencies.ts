import type { RunStore } from '../storage/index.js';

export interface RunLifecycleDependencies {
  readonly store: RunStore;
}
