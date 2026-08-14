import type { ExecutionPlan } from '../../../src/index.js';
import { parallelTerminalRecoveryPlan } from './parallel-terminal-recovery-plan.fixture.js';
import { delayRecoveryPlan, inlineDelayRecoveryPlan } from './recovery-delay-plans.fixture.js';
import {
  drainTransientRecoveryPlan,
  nestedCancelRecoveryPlan,
  parallelRecoveryPlan,
} from './recovery-parallel-plans.fixture.js';
import { recoverAbsentEffect, recoveryPolicies } from './recovery-plan-policy.fixture.js';
import { repeatRecoveryPlan } from './recovery-repeat-plan.fixture.js';

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
  policies: { ...recoveryPolicies, maximumTotalNodeExecutions: 4 },
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
  policies: { ...recoveryPolicies, maximumTotalNodeExecutions: 4 },
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
  policies: recoveryPolicies,
});

export const recoveryExecutionPlan = (scenario: string, retryDelayMs = 5_000): ExecutionPlan => {
  if (scenario === 'timeout') {
    return timeoutPlan;
  }
  if (scenario === 'retry') {
    return retryPlan(retryDelayMs);
  }
  if (scenario === 'delay') {
    return delayRecoveryPlan;
  }
  if (scenario === 'inline-delay') {
    return inlineDelayRecoveryPlan;
  }
  if (scenario === 'parallel') {
    return parallelRecoveryPlan;
  }
  if (scenario === 'parallel-terminal') {
    return parallelTerminalRecoveryPlan;
  }
  if (scenario === 'repeat') {
    return repeatRecoveryPlan;
  }
  if (scenario === 'nested-cancel') {
    return nestedCancelRecoveryPlan;
  }
  if (scenario === 'drain-transient') {
    return drainTransientRecoveryPlan;
  }
  return sequencePlan;
};
