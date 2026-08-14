import type { ExecutionPlan } from '../../../src/index.js';
import { recoverAbsentEffect, recoveryPolicies } from './recovery-plan-policy.fixture.js';

export const repeatRecoveryPlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'sequence',
        children: [
          {
            kind: 'repeat',
            key: 'loop',
            maximumIterations: 2,
            continueOn: ['retry'],
            completeOn: ['completed'],
            body: { kind: 'task', key: 'work', recovery: recoverAbsentEffect },
          },
          { kind: 'end', status: 'succeeded', outcome: 'completed' },
        ],
      },
    },
  },
  bindings: [
    {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'loop/work' },
      script: { id: 'test.repeat', revision: 1 },
    },
  ],
  policies: { ...recoveryPolicies, maximumTotalNodeExecutions: 4 },
};
