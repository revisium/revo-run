import type { ExecutionPlan } from '../../../src/index.js';

const policies = {
  defaultTaskTimeoutMs: 60_000,
  maximumActiveNodeExecutions: 1,
  maximumNodeNestingDepth: 4,
  maximumSubpipelineDepth: 1,
  maximumTotalNodeExecutions: 2,
} as const;

const recoverAbsentEffect = {
  reconciliation: 'required',
  maximumAttempts: 1,
  timeoutMs: 1_000,
  unknownOutcome: 'fail',
} as const;

const sequencePlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'sequence',
        children: [
          { kind: 'task', key: 'first', recovery: recoverAbsentEffect },
          { kind: 'task', key: 'second', recovery: recoverAbsentEffect },
          { kind: 'end', status: 'succeeded', outcome: 'completed' },
        ],
      },
    },
  },
  bindings: [
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'first' },
      script: { id: 'test.first', revision: 1 },
    },
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'second' },
      script: { id: 'test.second', revision: 1 },
    },
  ],
  policies: { ...policies, maximumTotalNodeExecutions: 4 },
};

const timeoutPlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'outcomeSwitch',
        source: { kind: 'task', key: 'work', timeoutMs: 25, recovery: recoverAbsentEffect },
        cases: {
          completed: { kind: 'end', status: 'failed', outcome: 'unexpected' },
          timedOut: {
            kind: 'sequence',
            children: [
              { kind: 'task', key: 'after-timeout', recovery: recoverAbsentEffect },
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
      script: { id: 'test.timeout', revision: 1 },
    },
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'after-timeout' },
      script: { id: 'test.after-timeout', revision: 1 },
    },
  ],
  policies: { ...policies, maximumTotalNodeExecutions: 4 },
};

const retryPlan = (delayMs: number): ExecutionPlan => ({
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'outcomeSwitch',
        source: {
          kind: 'task',
          key: 'work',
          retry: {
            maximumAttempts: 2,
            backoff: { kind: 'constant', delayMs },
            retryableErrorCodes: ['rate_limited'],
          },
          recovery: recoverAbsentEffect,
        },
        cases: {
          completed: { kind: 'end', status: 'succeeded', outcome: 'completed' },
          failed: { kind: 'end', status: 'failed', outcome: 'failed' },
        },
      },
    },
  },
  bindings: [
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'work' },
      script: { id: 'test.retry', revision: 1 },
    },
  ],
  policies,
});

const parallelPlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'sequence',
        children: [
          {
            kind: 'parallel',
            key: 'work',
            branches: {
              a: { kind: 'task', key: 'a', recovery: recoverAbsentEffect },
              b: { kind: 'task', key: 'b', recovery: recoverAbsentEffect },
            },
            join: {
              kind: 'all',
              successfulOutcomes: ['completed'],
              remaining: 'drain',
            },
          },
          { kind: 'end', status: 'succeeded', outcome: 'completed' },
        ],
      },
    },
  },
  bindings: [
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'work/a' },
      script: { id: 'test.a', revision: 1 },
    },
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'work/b' },
      script: { id: 'test.b', revision: 1 },
    },
  ],
  policies: { ...policies, maximumActiveNodeExecutions: 2, maximumTotalNodeExecutions: 4 },
};

const nestedCancelPlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'sequence',
        children: [
          {
            kind: 'parallel',
            key: 'review',
            branches: {
              winner: { kind: 'task', key: 'winner', recovery: recoverAbsentEffect },
              nested: {
                kind: 'parallel',
                key: 'inner',
                branches: {
                  descendant: {
                    kind: 'task',
                    key: 'descendant',
                    recovery: recoverAbsentEffect,
                  },
                },
                join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
              },
            },
            join: { kind: 'any', successfulOutcomes: ['completed'], remaining: 'cancel' },
          },
          { kind: 'end', status: 'succeeded', outcome: 'completed' },
        ],
      },
    },
  },
  bindings: [
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'review/winner' },
      script: { id: 'test.winner', revision: 1 },
    },
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'review/inner/descendant' },
      script: { id: 'test.descendant', revision: 1 },
    },
  ],
  policies: { ...policies, maximumActiveNodeExecutions: 2, maximumTotalNodeExecutions: 4 },
};

const drainTransientPlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'sequence',
        children: [
          {
            kind: 'parallel',
            key: 'review',
            branches: {
              first: { kind: 'task', key: 'first', recovery: recoverAbsentEffect },
              second: { kind: 'task', key: 'second', recovery: recoverAbsentEffect },
              third: { kind: 'task', key: 'third', recovery: recoverAbsentEffect },
            },
            join: { kind: 'any', successfulOutcomes: ['completed'], remaining: 'drain' },
          },
          { kind: 'end', status: 'succeeded', outcome: 'completed' },
        ],
      },
    },
  },
  bindings: ['first', 'second', 'third'].map((key) => ({
    kind: 'script',
    target: { pipelineId: 'main', nodePath: `review/${key}` },
    script: { id: `test.${key}`, revision: 1 },
  })),
  policies: { ...policies, maximumActiveNodeExecutions: 1, maximumTotalNodeExecutions: 6 },
};

export const recoveryExecutionPlan = (scenario: string, retryDelayMs = 5_000): ExecutionPlan => {
  if (scenario === 'timeout') {
    return timeoutPlan;
  }
  if (scenario === 'retry') {
    return retryPlan(retryDelayMs);
  }
  if (scenario === 'parallel') {
    return parallelPlan;
  }
  if (scenario === 'nested-cancel') {
    return nestedCancelPlan;
  }
  if (scenario === 'drain-transient') {
    return drainTransientPlan;
  }
  return sequencePlan;
};
