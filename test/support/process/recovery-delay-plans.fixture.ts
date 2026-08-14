import type { ExecutionPlan } from '../../../src/index.js';
import { recoverAbsentEffect, recoveryPolicies } from './recovery-plan-policy.fixture.js';

export const delayRecoveryPlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'sequence',
        children: [
          { kind: 'delay', key: 'cooldown', durationMs: 5_000 },
          { kind: 'end', status: 'succeeded', outcome: 'completed' },
        ],
      },
    },
  },
  bindings: [],
  policies: recoveryPolicies,
};

export const inlineDelayRecoveryPlan: ExecutionPlan = {
  schemaVersion: 1,
  rootPipelineId: 'main',
  pipelines: {
    main: {
      root: {
        kind: 'sequence',
        children: [
          { kind: 'subpipeline', key: 'phase', pipelineId: 'child' },
          { kind: 'end', status: 'succeeded', outcome: 'completed' },
        ],
      },
    },
    child: {
      root: {
        kind: 'sequence',
        children: [
          { kind: 'task', key: 'ready', recovery: recoverAbsentEffect },
          { kind: 'delay', key: 'cooldown', durationMs: 5_000 },
          { kind: 'end', status: 'succeeded', outcome: 'completed' },
        ],
      },
    },
  },
  bindings: [
    {
      kind: 'script',
      target: { pipelineId: 'child', nodePath: 'ready' },
      script: { id: 'test.inline-ready', revision: 1 },
    },
  ],
  policies: { ...recoveryPolicies, maximumSubpipelineDepth: 2 },
};
