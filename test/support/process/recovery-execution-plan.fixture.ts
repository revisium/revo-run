import type { ExecutionPlan } from '../../../src/index.js';

const policies = {
  defaultTaskTimeoutMs: 60_000,
  maximumActiveNodeExecutions: 1,
  maximumNodeNestingDepth: 4,
  maximumSubpipelineDepth: 1,
  maximumTotalNodeExecutions: 2,
} as const;

const sequencePlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'sequence',
        children: [
          { kind: 'task', key: 'first' },
          { kind: 'task', key: 'second' },
          { kind: 'end', status: 'succeeded', outcome: 'completed' },
        ],
      },
    },
  },
  bindings: [
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'first' },
      script: { id: 'test.first', version: '1.0.0' },
    },
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'second' },
      script: { id: 'test.second', version: '1.0.0' },
    },
  ],
  policies,
};

const timeoutPlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'outcomeSwitch',
        source: { kind: 'task', key: 'work', timeoutMs: 25 },
        cases: {
          completed: { kind: 'end', status: 'failed', outcome: 'unexpected' },
          timedOut: {
            kind: 'sequence',
            children: [
              { kind: 'task', key: 'after-timeout' },
              { kind: 'end', status: 'succeeded', outcome: 'timeout-handled' },
            ],
          },
        },
      },
    },
  },
  bindings: [
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'work' },
      script: { id: 'test.timeout', version: '1.0.0' },
    },
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'after-timeout' },
      script: { id: 'test.after-timeout', version: '1.0.0' },
    },
  ],
  policies,
};

export const recoveryExecutionPlan = (scenario: string): ExecutionPlan =>
  scenario === 'timeout' ? timeoutPlan : sequencePlan;
