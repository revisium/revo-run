import type { RunExecutor } from '../../../src/index.js';

export const noopRunExecutor: RunExecutor = {
  execute: async () => ({
    kind: 'failed',
    error: {
      code: 'executor_unavailable',
      message: 'No test executor is configured.',
    },
  }),
};
