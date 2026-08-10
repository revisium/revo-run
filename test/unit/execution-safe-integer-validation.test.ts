import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import { ExecutionPlanSchema } from '../../src/contracts/run/execution-plan.js';
import { taskExecutionPlan, terminalExecutionPlan } from '../support/execution-plan.fixture.js';

describe('execution safe integer validation', () => {
  it('uses positive safe integers for every execution duration, capacity, and count bound', () => {
    const schema = Schema.Compile(ExecutionPlanSchema);
    const maximum = Number.MAX_SAFE_INTEGER;
    const terminal = terminalExecutionPlan();
    const taskPlan = taskExecutionPlan();
    const boundaryPlans: readonly {
      readonly name: string;
      readonly plan: (value: number) => unknown;
    }[] = [
      {
        name: 'default task timeout',
        plan: (value) => ({
          ...terminal,
          policies: { ...terminal.policies, defaultTaskTimeoutMs: value },
        }),
      },
      {
        name: 'maximum active executions',
        plan: (value) => ({
          ...terminal,
          policies: { ...terminal.policies, maximumActiveNodeExecutions: value },
        }),
      },
      {
        name: 'task timeout',
        plan: (value) => ({
          ...taskPlan,
          pipelines: { main: { root: { kind: 'task', key: 'work', timeoutMs: value } } },
        }),
      },
      {
        name: 'constant retry delay',
        plan: (value) => ({
          ...taskPlan,
          pipelines: {
            main: {
              root: {
                kind: 'task',
                key: 'work',
                retry: {
                  maximumAttempts: 1,
                  backoff: { kind: 'constant', delayMs: value },
                  retryableErrorCodes: [],
                },
              },
            },
          },
        }),
      },
      {
        name: 'exponential retry initial delay',
        plan: (value) => ({
          ...taskPlan,
          pipelines: {
            main: {
              root: {
                kind: 'task',
                key: 'work',
                retry: {
                  maximumAttempts: 1,
                  backoff: { kind: 'exponential', initialDelayMs: value, maximumDelayMs: maximum },
                  retryableErrorCodes: [],
                },
              },
            },
          },
        }),
      },
      {
        name: 'exponential retry maximum delay',
        plan: (value) => ({
          ...taskPlan,
          pipelines: {
            main: {
              root: {
                kind: 'task',
                key: 'work',
                retry: {
                  maximumAttempts: 1,
                  backoff: { kind: 'exponential', initialDelayMs: 1, maximumDelayMs: value },
                  retryableErrorCodes: [],
                },
              },
            },
          },
        }),
      },
      {
        name: 'recovery attempts',
        plan: (value) => ({
          ...taskPlan,
          pipelines: {
            main: {
              root: {
                kind: 'task',
                key: 'work',
                recovery: {
                  reconciliation: 'required',
                  maximumAttempts: value,
                  timeoutMs: 1,
                  unknownOutcome: 'fail',
                },
              },
            },
          },
        }),
      },
      {
        name: 'recovery timeout',
        plan: (value) => ({
          ...taskPlan,
          pipelines: {
            main: {
              root: {
                kind: 'task',
                key: 'work',
                recovery: {
                  reconciliation: 'required',
                  maximumAttempts: 1,
                  timeoutMs: value,
                  unknownOutcome: 'fail',
                },
              },
            },
          },
        }),
      },
      {
        name: 'parallel threshold',
        plan: (value) => ({
          ...terminal,
          pipelines: {
            main: {
              root: {
                kind: 'parallel',
                key: 'work',
                branches: { only: { kind: 'end', status: 'succeeded', outcome: 'completed' } },
                join: {
                  kind: 'threshold',
                  count: value,
                  successfulOutcomes: ['completed'],
                  remaining: 'drain',
                },
              },
            },
          },
        }),
      },
      {
        name: 'consensus quorum',
        plan: (value) => ({
          ...terminal,
          pipelines: {
            main: {
              root: {
                kind: 'consensus',
                key: 'review',
                participants: { reviewer: { kind: 'task', key: 'reviewer' } },
                policy: { kind: 'quorum', count: value },
                remaining: 'drain',
              },
            },
          },
        }),
      },
      {
        name: 'consensus approve threshold',
        plan: (value) => ({
          ...terminal,
          pipelines: {
            main: {
              root: {
                kind: 'consensus',
                key: 'review',
                participants: { reviewer: { kind: 'task', key: 'reviewer' } },
                policy: { kind: 'threshold', approve: value, reject: 1 },
                remaining: 'drain',
              },
            },
          },
        }),
      },
      {
        name: 'consensus reject threshold',
        plan: (value) => ({
          ...terminal,
          pipelines: {
            main: {
              root: {
                kind: 'consensus',
                key: 'review',
                participants: { reviewer: { kind: 'task', key: 'reviewer' } },
                policy: { kind: 'threshold', approve: 1, reject: value },
                remaining: 'drain',
              },
            },
          },
        }),
      },
      {
        name: 'consensus timeout',
        plan: (value) => ({
          ...terminal,
          pipelines: {
            main: {
              root: {
                kind: 'consensus',
                key: 'review',
                participants: { reviewer: { kind: 'task', key: 'reviewer' } },
                policy: { kind: 'unanimous' },
                remaining: 'drain',
                timeoutMs: value,
              },
            },
          },
        }),
      },
      {
        name: 'human gate answer count',
        plan: (value) => ({
          ...terminal,
          pipelines: {
            main: {
              root: {
                kind: 'humanGate',
                key: 'approval',
                answers: ['yes'],
                decision: { kind: 'matchingAnswers', count: value, onConflict: 'wait' },
              },
            },
          },
        }),
      },
      {
        name: 'human gate timeout',
        plan: (value) => ({
          ...terminal,
          pipelines: {
            main: {
              root: {
                kind: 'humanGate',
                key: 'approval',
                answers: ['yes'],
                decision: { kind: 'firstAnswer' },
                timeoutMs: value,
              },
            },
          },
        }),
      },
      {
        name: 'map concurrency',
        plan: (value) => ({
          ...terminal,
          pipelines: {
            main: {
              root: {
                kind: 'map',
                key: 'items',
                items: { kind: 'runInput', path: '/items' },
                itemKeyPath: '/id',
                maximumItems: 1,
                concurrency: value,
                failure: { kind: 'collect' },
                body: { kind: 'end', status: 'succeeded', outcome: 'completed' },
              },
            },
          },
        }),
      },
      {
        name: 'delay duration',
        plan: (value) => ({
          ...terminal,
          pipelines: { main: { root: { kind: 'delay', key: 'wait', durationMs: value } } },
        }),
      },
    ];

    for (const boundary of boundaryPlans) {
      expect({ name: boundary.name, accepted: schema.Check(boundary.plan(maximum)) }).toEqual({
        name: boundary.name,
        accepted: true,
      });
      expect({ name: boundary.name, accepted: schema.Check(boundary.plan(maximum + 1)) }).toEqual({
        name: boundary.name,
        accepted: false,
      });
    }
  });
});
