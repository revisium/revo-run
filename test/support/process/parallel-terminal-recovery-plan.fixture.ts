import type { ExecutionPlan } from '../../../src/index.js';
import { recoverAbsentEffect, recoveryPolicies } from './recovery-plan-policy.fixture.js';

export const parallelTerminalRecoveryPlan: ExecutionPlan = {
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
              terminal: {
                kind: 'repeat',
                key: 'inner',
                maximumIterations: 1,
                continueOn: ['retry'],
                completeOn: ['approved'],
                body: { kind: 'task', key: 'invalid', recovery: recoverAbsentEffect },
              },
              pending: { kind: 'task', key: 'pending', recovery: recoverAbsentEffect },
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
      target: { pipelineId: 'main', nodePath: 'review/inner/invalid' },
      script: { id: 'test.parallel-terminal', revision: 1 },
    },
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'review/pending' },
      script: { id: 'test.parallel-pending', revision: 1 },
    },
  ],
  policies: {
    ...recoveryPolicies,
    maximumActiveNodeExecutions: 2,
    maximumNodeNestingDepth: 5,
    maximumTotalNodeExecutions: 4,
  },
};
