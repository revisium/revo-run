import { describe, expect, it } from 'vitest';

import type { ExecutionPlan } from '../../src/index.js';
import { ExecutionPlanValidator } from '../../src/validation/execution-plan.validator.js';
import { end, executionPlan, scriptBinding, sequence, task } from '../dsl/pipeline-builder.js';

const validationCode = (plan: ExecutionPlan): string | undefined => {
  const result = ExecutionPlanValidator.Validate(plan);
  return result.valid ? undefined : result.code;
};

describe('execution plan admission semantics', () => {
  it('requires a default route for data-driven branches', () => {
    const plan = executionPlan({
      kind: 'branch',
      key: 'route',
      value: { kind: 'runInput', path: '/risk' },
      cases: { low: end('succeeded') },
    });

    expect(validationCode(plan)).toBe('missing_branch_default');
  });

  it('rejects unreachable consensus thresholds', () => {
    const plan = executionPlan(
      {
        kind: 'consensus',
        key: 'review',
        participants: { a: task('a'), b: task('b') },
        policy: { kind: 'threshold', approve: 3, reject: 2 },
        remaining: 'cancel',
      },
      {
        bindings: [scriptBinding('review/a', 'review.a'), scriptBinding('review/b', 'review.b')],
      },
    );

    expect(validationCode(plan)).toBe('unreachable_consensus_threshold');
  });

  it('rejects repeated and composed execution bounds above the plan budget', () => {
    const repeated = executionPlan(
      {
        kind: 'repeat',
        key: 'review',
        maximumIterations: 11,
        continueOn: ['retry'],
        completeOn: ['completed'],
        body: task('work'),
      },
      {
        bindings: [scriptBinding('review/work', 'review.work')],
        policies: { maximumTotalNodeExecutions: 10 },
      },
    );
    const composed = executionPlan(
      {
        kind: 'map',
        key: 'repositories',
        items: { kind: 'runInput', path: '/repositories' },
        itemKeyPath: '/id',
        maximumItems: 3,
        concurrency: 2,
        failure: { kind: 'collect' },
        body: {
          kind: 'repeat',
          key: 'review',
          maximumIterations: 2,
          continueOn: ['retry'],
          completeOn: ['completed'],
          body: task('work'),
        },
      },
      {
        bindings: [scriptBinding('repositories/review/work', 'review.work')],
        policies: { maximumTotalNodeExecutions: 5 },
      },
    );

    expect(validationCode(repeated)).toBe('execution_bound_exceeded');
    expect(validationCode(composed)).toBe('execution_bound_exceeded');
  });

  it('pre-checks additive overflow against the configured safe limit', () => {
    const retry = {
      maximumAttempts: Number.MAX_SAFE_INTEGER,
      backoff: { kind: 'constant', delayMs: 1 },
      retryableErrorCodes: [],
    } as const;
    const plan = executionPlan(sequence(task('a', { retry }), task('b')), {
      bindings: [scriptBinding('a', 'a'), scriptBinding('b', 'b')],
      policies: { maximumTotalNodeExecutions: Number.MAX_SAFE_INTEGER },
    });

    expect(validationCode(plan)).toBe('execution_bound_exceeded');
  });

  it('enforces the root task retry bound at the final budget comparison', () => {
    const retry = {
      maximumAttempts: 3,
      backoff: { kind: 'constant', delayMs: 1 },
      retryableErrorCodes: [],
    } as const;
    const plan = (maximumTotalNodeExecutions: number) =>
      executionPlan(task('work', { retry }), {
        bindings: [scriptBinding('work', 'work')],
        policies: { maximumTotalNodeExecutions },
      });

    expect(ExecutionPlanValidator.Check(plan(3))).toBe(true);
    expect(validationCode(plan(2))).toBe('execution_bound_exceeded');
  });

  it('enforces the maximum branch bound at the final budget comparison', () => {
    const retry = (maximumAttempts: number) => ({
      maximumAttempts,
      backoff: { kind: 'constant', delayMs: 1 } as const,
      retryableErrorCodes: [],
    });
    const plan = (maximumTotalNodeExecutions: number) =>
      executionPlan(
        {
          kind: 'branch',
          key: 'route',
          value: { kind: 'runInput', path: '/route' },
          cases: {
            short: task('short', { retry: retry(2) }),
            long: task('long', { retry: retry(3) }),
          },
          default: end('failed'),
        },
        {
          bindings: [scriptBinding('route/short', 'short'), scriptBinding('route/long', 'long')],
          policies: { maximumTotalNodeExecutions },
        },
      );

    expect(ExecutionPlanValidator.Check(plan(3))).toBe(true);
    expect(validationCode(plan(2))).toBe('execution_bound_exceeded');
  });

  it('propagates a subpipeline bound into the root final comparison', () => {
    const retry = {
      maximumAttempts: 3,
      backoff: { kind: 'constant', delayMs: 1 },
      retryableErrorCodes: [],
    } as const;
    const plan = (maximumTotalNodeExecutions: number) =>
      executionPlan(
        { kind: 'subpipeline', key: 'child', pipelineId: 'child' },
        {
          pipelines: { child: task('work', { retry }) },
          bindings: [scriptBinding('work', 'work', { pipelineId: 'child' })],
          policies: { maximumTotalNodeExecutions },
        },
      );

    expect(ExecutionPlanValidator.Check(plan(3))).toBe(true);
    expect(validationCode(plan(2))).toBe('execution_bound_exceeded');
  });
});
