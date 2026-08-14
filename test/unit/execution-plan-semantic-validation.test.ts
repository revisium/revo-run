import { describe, expect, it } from 'vitest';

import type { ExecutionPlan, PipelineNode } from '../../src/index.js';
import {
  type ExecutionPlanValidationErrorCode,
  ExecutionPlanValidator,
} from '../../src/validation/execution-plan.validator.js';

const defaultPolicies = {
  defaultTaskTimeoutMs: 60_000,
  maximumActiveNodeExecutions: 4,
  maximumNodeNestingDepth: 10,
  maximumSubpipelineDepth: 10,
  maximumTotalNodeExecutions: 100,
} as const;

const executionPlan = (
  root: PipelineNode,
  options: {
    readonly pipelines?: ExecutionPlan['pipelines'];
    readonly bindings?: ExecutionPlan['bindings'];
    readonly policies?: Partial<ExecutionPlan['policies']>;
    readonly rootPipelineId?: string;
  } = {},
): ExecutionPlan => ({
  schemaVersion: 1,
  rootPipelineId: options.rootPipelineId ?? 'main',
  pipelines: { ...options.pipelines, main: { root } },
  bindings: options.bindings ?? [],
  policies: { ...defaultPolicies, ...options.policies },
});

const end: PipelineNode = {
  kind: 'end',
  status: 'succeeded',
  outcome: 'completed',
};

const validationError = (plan: ExecutionPlan): ExecutionPlanValidationErrorCode | undefined => {
  const result = ExecutionPlanValidator.Validate(plan);
  return result.valid ? undefined : result.code;
};

const subpipeline = (key: string, pipelineId: string): PipelineNode => ({
  kind: 'subpipeline',
  key,
  pipelineId,
});

describe('execution plan semantic validation', () => {
  it('accepts explicit bounded repetition', () => {
    const plan = executionPlan(
      {
        kind: 'repeat',
        key: 'review',
        maximumIterations: 3,
        continueOn: ['retry'],
        completeOn: ['completed'],
        body: { kind: 'task', key: 'work' },
      },
      {
        bindings: [
          {
            kind: 'script',
            target: { pipelineId: 'main', nodePath: 'review/work' },
            script: { id: 'example.run', revision: 1 },
          },
        ],
      },
    );

    expect(ExecutionPlanValidator.Check(plan)).toBe(true);
  });

  it.each([1, 3])(
    'rejects overlapping repeat outcome sets at admission with a maximum of %i iteration(s)',
    (maximumIterations) => {
      const plan = executionPlan(
        {
          kind: 'repeat',
          key: 'review',
          maximumIterations,
          continueOn: ['retry', 'completed'],
          completeOn: ['completed'],
          body: { kind: 'task', key: 'work' },
        },
        {
          bindings: [
            {
              kind: 'script',
              target: { pipelineId: 'main', nodePath: 'review/work' },
              script: { id: 'example.run', revision: 1 },
            },
          ],
        },
      );

      expect(validationError(plan)).toBe('overlapping_repeat_outcome_sets');
    },
  );

  it('rejects structural nesting beyond the plan bound', () => {
    const plan = executionPlan(
      {
        kind: 'sequence',
        children: [{ kind: 'sequence', children: [end] }],
      },
      { policies: { maximumNodeNestingDepth: 2 } },
    );

    expect(validationError(plan)).toBe('node_depth_exceeded');
  });

  it('accepts structural nesting exactly at the plan bound', () => {
    const plan = executionPlan(
      {
        kind: 'sequence',
        children: [{ kind: 'sequence', children: [end] }],
      },
      { policies: { maximumNodeNestingDepth: 3 } },
    );

    expect(ExecutionPlanValidator.Check(plan)).toBe(true);
  });

  it('rejects a missing subpipeline dependency', () => {
    const plan = executionPlan({
      kind: 'subpipeline',
      key: 'missing',
      pipelineId: 'missing',
    });

    expect(validationError(plan)).toBe('pipeline_not_found');
  });

  it('rejects direct subpipeline recursion', () => {
    const plan = executionPlan(subpipeline('self', 'main'));

    expect(validationError(plan)).toBe('subpipeline_cycle');
  });

  it('rejects indirect subpipeline recursion', () => {
    const plan = executionPlan(
      { kind: 'subpipeline', key: 'child', pipelineId: 'child' },
      {
        pipelines: {
          child: {
            root: { kind: 'subpipeline', key: 'parent', pipelineId: 'main' },
          },
        },
      },
    );

    expect(validationError(plan)).toBe('subpipeline_cycle');
  });

  it('does not treat inherited object properties as pipelines', () => {
    const missingRoot = executionPlan(end, { rootPipelineId: 'constructor' });
    const missingDependency = executionPlan(subpipeline('child', 'toString'));

    expect(validationError(missingRoot)).toBe('root_pipeline_not_found');
    expect(validationError(missingDependency)).toBe('pipeline_not_found');
  });

  it('rejects subpipeline composition beyond the plan bound', () => {
    const plan = executionPlan(
      { kind: 'subpipeline', key: 'child', pipelineId: 'child' },
      {
        pipelines: {
          child: {
            root: { kind: 'subpipeline', key: 'grandchild', pipelineId: 'grandchild' },
          },
          grandchild: { root: end },
        },
        policies: { maximumSubpipelineDepth: 2 },
      },
    );

    expect(validationError(plan)).toBe('subpipeline_depth_exceeded');
  });

  it('accepts subpipeline composition exactly at the plan bound', () => {
    const plan = executionPlan(subpipeline('child', 'child'), {
      pipelines: {
        child: { root: subpipeline('grandchild', 'grandchild') },
        grandchild: { root: end },
      },
      policies: { maximumSubpipelineDepth: 3 },
    });

    expect(ExecutionPlanValidator.Check(plan)).toBe(true);
  });

  it('validates a wide layered dependency graph without enumerating its paths', () => {
    const pipelineCount = 31;
    const duplicateEdgesPerPipeline = 10;
    const pipelines: Record<string, { readonly root: PipelineNode }> = {};

    for (let index = 1; index < pipelineCount; index += 1) {
      const pipelineId = `pipeline-${index}`;
      const nextPipelineId = `pipeline-${index + 1}`;
      pipelines[pipelineId] = {
        root: {
          kind: 'sequence',
          children: Array.from({ length: duplicateEdgesPerPipeline }, (_, childIndex) =>
            subpipeline(`call-${childIndex}`, nextPipelineId),
          ),
        },
      };
    }
    pipelines[`pipeline-${pipelineCount}`] = { root: end };

    const plan = executionPlan(subpipeline('pipeline-1', 'pipeline-1'), {
      pipelines,
      policies: { maximumSubpipelineDepth: 32 },
    });

    expect(ExecutionPlanValidator.Check(plan)).toBe(true);
  });

  it('rejects depth policies above the system hard limit', () => {
    const plan = executionPlan(end, {
      policies: { maximumNodeNestingDepth: 33 },
    });

    expect(ExecutionPlanValidator.Check(plan)).toBe(false);
  });

  it('rejects duplicate node keys', () => {
    const plan = executionPlan({
      kind: 'sequence',
      children: [
        { kind: 'task', key: 'work' },
        { kind: 'task', key: 'work' },
      ],
    });

    expect(validationError(plan)).toBe('duplicate_node_key');
  });

  it('rejects a parallel threshold above the branch count', () => {
    const plan = executionPlan({
      kind: 'parallel',
      key: 'review',
      branches: { first: end, second: end },
      join: {
        kind: 'threshold',
        count: 3,
        successfulOutcomes: ['completed'],
        remaining: 'drain',
      },
    });

    expect(validationError(plan)).toBe('unreachable_parallel_threshold');
  });

  it('rejects duplicate executor bindings', () => {
    const binding = {
      kind: 'script',
      target: { pipelineId: 'main', nodePath: 'work' },
      script: { id: 'example.run', revision: 1 },
    } as const;
    const plan: ExecutionPlan = {
      ...executionPlan({ kind: 'task', key: 'work' }),
      bindings: [binding, binding],
    };

    expect(validationError(plan)).toBe('duplicate_executor_binding');
  });

  it('rejects a task without an executor binding', () => {
    const plan = executionPlan({ kind: 'task', key: 'work' });

    expect(validationError(plan)).toBe('missing_executor_binding');
  });

  it('rejects an executor binding whose node does not exist', () => {
    const plan = executionPlan(end, {
      bindings: [
        {
          kind: 'script',
          target: { pipelineId: 'main', nodePath: 'missing' },
          script: { id: 'example.run', revision: 1 },
        },
      ],
    });

    expect(validationError(plan)).toBe('binding_target_not_found');
  });

  it('rejects an executor binding whose pipeline does not exist', () => {
    const plan = executionPlan(end, {
      bindings: [
        {
          kind: 'script',
          target: { pipelineId: 'missing', nodePath: 'work' },
          script: { id: 'example.run', revision: 1 },
        },
      ],
    });

    expect(validationError(plan)).toBe('binding_target_not_found');
  });

  it('rejects an executor binding that targets a control node', () => {
    const plan = executionPlan(
      {
        kind: 'sequence',
        children: [{ kind: 'delay', key: 'cooldown', durationMs: 1_000 }, end],
      },
      {
        bindings: [
          {
            kind: 'script',
            target: { pipelineId: 'main', nodePath: 'cooldown' },
            script: { id: 'example.run', revision: 1 },
          },
        ],
      },
    );

    expect(validationError(plan)).toBe('binding_target_not_task');
  });
});
