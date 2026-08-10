import { describe, expect, it } from 'vitest';

import { ExecutionPlanValidator } from '../../src/validation/execution-plan.validator.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const planWithRoot = (
  root: unknown,
  pipelines: Readonly<Record<string, unknown>> = {},
): unknown => {
  const plan = terminalExecutionPlan();
  return {
    ...plan,
    pipelines: {
      main: { root },
      ...Object.fromEntries(
        Object.entries(pipelines).map(([pipelineId, pipelineRoot]) => [
          pipelineId,
          { root: pipelineRoot },
        ]),
      ),
    },
  };
};

const validationCode = (plan: unknown): string | undefined => {
  const result = ExecutionPlanValidator.Validate(plan);
  return result.valid ? undefined : result.code;
};

describe('execution plan schema error classification', () => {
  it.each([
    [
      'task pipelineId extra',
      planWithRoot({ kind: 'task', key: 'work', pipelineId: 'invalid/pipeline' }),
    ],
    [
      'task maximumIterations extra',
      planWithRoot({ kind: 'task', key: 'work', maximumIterations: 0 }),
    ],
    [
      'repeat pipelineId extra',
      planWithRoot({
        kind: 'repeat',
        key: 'repeat',
        maximumIterations: 1,
        continueOn: ['again'],
        completeOn: ['completed'],
        body: { kind: 'end', status: 'succeeded', outcome: 'completed' },
        pipelineId: 'invalid/pipeline',
      }),
    ],
    [
      'subpipeline maximumIterations extra',
      planWithRoot(
        {
          kind: 'subpipeline',
          key: 'child',
          pipelineId: 'child',
          maximumIterations: 0,
        },
        { child: { kind: 'end', status: 'succeeded', outcome: 'completed' } },
      ),
    ],
    [
      'key on a keyless end node',
      planWithRoot({
        kind: 'end',
        key: 'invalid/key',
        status: 'succeeded',
        outcome: 'completed',
      }),
    ],
    [
      'unknown node kind with specialized-looking fields',
      planWithRoot({
        kind: 'future',
        key: 'invalid/key',
        pipelineId: 'invalid/pipeline',
        maximumIterations: 0,
      }),
    ],
  ])('falls back to invalid_execution_plan for %s', (_label, plan) => {
    expect(validationCode(plan)).toBe('invalid_execution_plan');
  });

  it.each([
    ['invalid_node_key', planWithRoot({ kind: 'task', key: 'invalid/key' })],
    [
      'invalid_pipeline_id',
      planWithRoot({ kind: 'subpipeline', key: 'child', pipelineId: 'invalid/pipeline' }),
    ],
    [
      'invalid_repeat_bound',
      planWithRoot({
        kind: 'repeat',
        key: 'repeat',
        maximumIterations: 0,
        continueOn: ['again'],
        completeOn: ['completed'],
        body: { kind: 'end', status: 'succeeded', outcome: 'completed' },
      }),
    ],
  ])('preserves %s for its discriminated node kind', (code, plan) => {
    expect(validationCode(plan)).toBe(code);
  });

  it.each([
    [
      'repeat',
      {
        kind: 'repeat',
        key: 'repeat',
        maximumIterations: 0,
        continueOn: ['again'],
        completeOn: ['completed'],
        body: { kind: 'end', status: 'succeeded', outcome: 'completed' },
      },
    ],
    ['subpipeline', { kind: 'subpipeline', key: 'child', pipelineId: 'invalid/pipeline' }],
  ])('does not specialize an illegal %s consensus participant', (_label, participant) => {
    expect(
      validationCode(
        planWithRoot({
          kind: 'consensus',
          key: 'decision',
          participants: { reviewer: participant },
          policy: { kind: 'unanimous' },
          remaining: 'drain',
        }),
      ),
    ).toBe('invalid_execution_plan');
  });

  it('classifies an invalid task key inside consensus participants', () => {
    expect(
      validationCode(
        planWithRoot({
          kind: 'consensus',
          key: 'decision',
          participants: { reviewer: { kind: 'task', key: 'invalid/key' } },
          policy: { kind: 'unanimous' },
          remaining: 'drain',
        }),
      ),
    ).toBe('invalid_node_key');
  });

  it.each([
    [
      'agent',
      {
        kind: 'agent',
        target: { pipelineId: 'invalid/pipeline', nodePath: 'work' },
        agentId: 'agent',
        roleId: 'reviewer',
        modelId: 'model',
      },
      'invalid_pipeline_id',
    ],
    [
      'script',
      {
        kind: 'script',
        target: { pipelineId: 'invalid/pipeline', nodePath: 'work' },
        script: { id: 'example.run', revision: 1 },
      },
      'invalid_pipeline_id',
    ],
    [
      'missing kind',
      { target: { pipelineId: 'invalid/pipeline', nodePath: 'work' } },
      'invalid_execution_plan',
    ],
    [
      'unknown kind',
      { kind: 'future', target: { pipelineId: 'invalid/pipeline', nodePath: 'work' } },
      'invalid_execution_plan',
    ],
    [
      'non-string kind',
      { kind: 1, target: { pipelineId: 'invalid/pipeline', nodePath: 'work' } },
      'invalid_execution_plan',
    ],
    [
      'top-level pipelineId extra',
      {
        kind: 'script',
        pipelineId: 'invalid/pipeline',
        target: { pipelineId: 'main', nodePath: 'work' },
        script: { id: 'example.run', revision: 1 },
      },
      'invalid_execution_plan',
    ],
  ])('classifies %s binding target context', (_label, binding, code) => {
    expect(validationCode({ ...terminalExecutionPlan(), bindings: [binding] })).toBe(code);
  });

  it('ignores inert JSON fields when another contract property is invalid', () => {
    expect(
      validationCode(
        planWithRoot({
          kind: 'task',
          key: 'work',
          input: {
            payload: {
              kind: 'literal',
              value: {
                kind: 'repeat',
                key: 'invalid/key',
                pipelineId: 'invalid/pipeline',
                maximumIterations: 0,
              },
            },
          },
          unexpected: true,
        }),
      ),
    ).toBe('invalid_execution_plan');
  });
});
