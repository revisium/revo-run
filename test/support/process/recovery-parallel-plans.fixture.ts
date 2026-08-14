import type { ExecutionPlan } from '../../../src/index.js';
import { recoverAbsentEffect, recoveryPolicies } from './recovery-plan-policy.fixture.js';

export const parallelRecoveryPlan: ExecutionPlan = {
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
  policies: {
    ...recoveryPolicies,
    maximumActiveNodeExecutions: 2,
    maximumTotalNodeExecutions: 4,
  },
};

export const nestedCancelRecoveryPlan: ExecutionPlan = {
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
  policies: {
    ...recoveryPolicies,
    maximumActiveNodeExecutions: 2,
    maximumTotalNodeExecutions: 4,
  },
};

export const drainTransientRecoveryPlan: ExecutionPlan = {
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
  policies: {
    ...recoveryPolicies,
    maximumActiveNodeExecutions: 1,
    maximumTotalNodeExecutions: 6,
  },
};
