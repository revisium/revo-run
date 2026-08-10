import type { ExecutionPlan } from '../../src/index.js';

const policies = {
  defaultTaskTimeoutMs: 60_000,
  maximumActiveNodeExecutions: 1,
  maximumNodeNestingDepth: 2,
  maximumSubpipelineDepth: 1,
  maximumTotalNodeExecutions: 1,
} as const;

export const terminalExecutionPlan = (): ExecutionPlan => ({
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: { root: { kind: 'end', status: 'succeeded', outcome: 'succeeded' } },
  },
  bindings: [],
  policies,
});

export const taskExecutionPlan = (): ExecutionPlan => ({
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: { root: { kind: 'task', key: 'work' } },
  },
  bindings: [
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'work' },
      script: { id: 'test.unsupported', revision: 1 },
    },
  ],
  policies,
});
