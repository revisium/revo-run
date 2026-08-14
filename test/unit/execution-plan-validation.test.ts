import { describe, expect, it } from 'vitest';

import { ExecutionPlanValidator } from '../../src/validation/execution-plan.validator.js';
import { taskExecutionPlan, terminalExecutionPlan } from '../support/execution-plan.fixture.js';

describe('execution plan validation', () => {
  it('accepts a complete supported execution plan', () => {
    expect(ExecutionPlanValidator.Check(terminalExecutionPlan())).toBe(true);
  });

  it('rejects additional contract properties', () => {
    expect(
      ExecutionPlanValidator.Check({
        ...terminalExecutionPlan(),
        unexpected: true,
      }),
    ).toBe(false);
  });

  it('rejects malformed nested pipeline nodes', () => {
    const plan = terminalExecutionPlan();

    expect(
      ExecutionPlanValidator.Check({
        ...plan,
        pipelines: {
          main: {
            root: {
              ...plan.pipelines['main']?.root,
              unexpected: true,
            },
          },
        },
      }),
    ).toBe(false);
  });

  it.each([
    ['invalid_node_key', { kind: 'sequence', children: [{ kind: 'task', key: 'invalid/key' }] }],
    [
      'invalid_pipeline_id',
      {
        kind: 'sequence',
        children: [{ kind: 'subpipeline', key: 'child', pipelineId: 'invalid/pipeline' }],
      },
    ],
    [
      'invalid_repeat_bound',
      {
        kind: 'sequence',
        children: [
          {
            kind: 'repeat',
            key: 'repeat',
            maximumIterations: 0,
            continueOn: ['again'],
            completeOn: ['completed'],
            body: { kind: 'end', status: 'succeeded', outcome: 'completed' },
          },
        ],
      },
    ],
  ])('classifies nested contract failure %s from compiled field paths', (code, root) => {
    const plan = terminalExecutionPlan();

    expect(
      ExecutionPlanValidator.Validate({
        ...plan,
        pipelines: { main: { root } },
      }),
    ).toEqual({ valid: false, code });
  });

  it('rejects identifiers outside the contract grammar', () => {
    expect(
      ExecutionPlanValidator.Check({
        ...terminalExecutionPlan(),
        rootPipelineId: 'invalid/pipeline',
      }),
    ).toBe(false);
  });

  it('rejects invalid pipeline-relative node paths', () => {
    expect(
      ExecutionPlanValidator.Check({
        ...terminalExecutionPlan(),
        bindings: [
          {
            kind: 'script',
            target: { pipelineId: 'main', nodePath: 'invalid//path' },
            script: { id: 'example', revision: 1 },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects secret references in terminal output mappings', () => {
    const plan = terminalExecutionPlan();

    expect(
      ExecutionPlanValidator.Check({
        ...plan,
        pipelines: {
          main: {
            root: {
              kind: 'end',
              status: 'succeeded',
              outcome: 'completed',
              output: {
                credential: {
                  kind: 'secret',
                  reference: { name: 'production-token' },
                },
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it('does not apply execution bounds to artifact size metadata', () => {
    const plan = taskExecutionPlan();

    expect(
      ExecutionPlanValidator.Check({
        ...plan,
        pipelines: {
          main: {
            root: {
              kind: 'task',
              key: 'work',
              input: {
                artifact: {
                  kind: 'artifact',
                  reference: {
                    id: 'artifact-1',
                    digest: 'sha256:example',
                    mediaType: 'application/json',
                    size: Number.MAX_SAFE_INTEGER + 1,
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it('accepts only positive safe integer script revisions', () => {
    const plan = terminalExecutionPlan();
    const withRevision = (revision: number) => ({
      ...plan,
      bindings: [
        {
          kind: 'script',
          target: { pipelineId: 'main', nodePath: 'missing' },
          script: { id: 'example', revision },
        },
      ],
    });

    const validationCode = (revision: number) => {
      const validation = ExecutionPlanValidator.Validate(withRevision(revision));
      return validation.valid ? undefined : validation.code;
    };

    expect(validationCode(1)).toBe('binding_target_not_found');
    expect(validationCode(Number.MAX_SAFE_INTEGER)).toBe('binding_target_not_found');
    expect(ExecutionPlanValidator.Check(withRevision(0))).toBe(false);
    expect(ExecutionPlanValidator.Check(withRevision(Number.MAX_SAFE_INTEGER + 1))).toBe(false);
    expect(
      ExecutionPlanValidator.Check({
        ...withRevision(1),
        bindings: [
          {
            kind: 'script',
            target: { pipelineId: 'main', nodePath: 'missing' },
            script: { id: 'example', version: '1.0.0' },
          },
        ],
      }),
    ).toBe(false);
  });

  it('uses positive safe integers only for execution cardinality fields', () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const terminal = terminalExecutionPlan();
    const taskPlan = taskExecutionPlan();
    const withMaximumTotal = (value: number) => ({
      ...terminal,
      policies: { ...terminal.policies, maximumTotalNodeExecutions: value },
    });
    const withRetryAttempts = (value: number) => ({
      ...taskPlan,
      policies: { ...taskPlan.policies, maximumTotalNodeExecutions: maximum },
      pipelines: {
        main: {
          root: {
            kind: 'task',
            key: 'work',
            retry: {
              maximumAttempts: value,
              backoff: { kind: 'constant', delayMs: 1 },
              retryableErrorCodes: [],
            },
          },
        },
      },
    });
    const withRepeatIterations = (value: number) => ({
      ...terminal,
      policies: { ...terminal.policies, maximumTotalNodeExecutions: maximum },
      bindings: [
        {
          kind: 'script',
          target: { pipelineId: 'main', nodePath: 'repeat/work' },
          script: { id: 'example.run', revision: 1 },
        },
      ],
      pipelines: {
        main: {
          root: {
            kind: 'repeat',
            key: 'repeat',
            maximumIterations: value,
            continueOn: ['again'],
            completeOn: ['completed'],
            body: { kind: 'task', key: 'work' },
          },
        },
      },
    });
    const withMapItems = (value: number) => ({
      ...terminal,
      policies: { ...terminal.policies, maximumTotalNodeExecutions: maximum },
      pipelines: {
        main: {
          root: {
            kind: 'map',
            key: 'items',
            items: { kind: 'runInput', path: '/items' },
            itemKeyPath: '/id',
            maximumItems: value,
            concurrency: 1,
            failure: { kind: 'collect' },
            body: { kind: 'end', status: 'succeeded', outcome: 'completed' },
          },
        },
      },
    });

    for (const plan of [
      withMaximumTotal(maximum),
      withRetryAttempts(maximum),
      withRepeatIterations(maximum),
      withMapItems(maximum),
    ]) {
      expect(ExecutionPlanValidator.Check(plan)).toBe(true);
    }
    for (const plan of [
      withMaximumTotal(maximum + 1),
      withRetryAttempts(maximum + 1),
      withRepeatIterations(maximum + 1),
      withMapItems(maximum + 1),
    ]) {
      expect(ExecutionPlanValidator.Check(plan)).toBe(false);
    }
  });

  it('does not classify literal JSON keys while the plan has an unrelated schema failure', () => {
    const plan = taskExecutionPlan();
    const result = ExecutionPlanValidator.Validate({
      ...plan,
      pipelines: {
        main: {
          root: {
            kind: 'task',
            key: 'work',
            input: { payload: { kind: 'literal', value: { key: 'invalid/key' } } },
            unexpected: true,
          },
        },
      },
    });

    expect(result).toEqual({ valid: false, code: 'invalid_execution_plan' });
  });
});
