import type { RunStore } from '../storage/index.js';
import type { LifecycleInitializeSingleTaskRunRequest } from './lifecycle-initialize-single-task-run-request.js';
import type { LifecycleProgressSingleTaskOutcomeRequest } from './lifecycle-progress-single-task-outcome-request.js';
import type { LifecycleSingleTaskProgressionResult } from './lifecycle-single-task-progression-result.js';
import { singleTaskProgression } from './single-task-progression.js';

export const createSingleTaskProgressionLifecycle = (store: RunStore) =>
  Object.freeze({
    initializeSingleTaskRun: (
      request: LifecycleInitializeSingleTaskRunRequest,
    ): Promise<LifecycleSingleTaskProgressionResult> =>
      singleTaskProgression.initialize(store, request),
    progressSingleTaskOutcome: (
      request: LifecycleProgressSingleTaskOutcomeRequest,
    ): Promise<LifecycleSingleTaskProgressionResult> =>
      singleTaskProgression.progressOutcome(store, request),
  });
