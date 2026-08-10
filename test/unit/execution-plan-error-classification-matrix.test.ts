import { describe, expect, it } from 'vitest';

import { ExecutionPlanValidator } from '../../src/validation/execution-plan.validator.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const keyedKinds = [
  'branch',
  'consensus',
  'delay',
  'humanGate',
  'map',
  'parallel',
  'repeat',
  'subpipeline',
  'task',
] as const;

const keylessKinds = ['end', 'outcomeSwitch', 'sequence'] as const;
const nodeKinds = [...keyedKinds, ...keylessKinds] as const;

const validationCodeForRoot = (root: unknown): string | undefined => {
  const plan = terminalExecutionPlan();
  const result = ExecutionPlanValidator.Validate({
    ...plan,
    pipelines: { main: { root } },
  });
  return result.valid ? undefined : result.code;
};

const invalidTask = { kind: 'task', key: 'invalid/key' } as const;

describe('execution plan schema error classification matrix', () => {
  it.each(keyedKinds)('classifies invalid keys for keyed %s nodes', (kind) => {
    expect(validationCodeForRoot({ kind, key: 'invalid/key' })).toBe('invalid_node_key');
  });

  it.each(keylessKinds)('does not classify a key on keyless %s nodes', (kind) => {
    expect(validationCodeForRoot({ kind, key: 'invalid/key' })).toBe('invalid_execution_plan');
  });

  it.each(nodeKinds)('classifies pipelineId only for subpipeline, not %s by shape', (kind) => {
    const expected = kind === 'subpipeline' ? 'invalid_pipeline_id' : 'invalid_execution_plan';
    expect(validationCodeForRoot({ kind, pipelineId: 'invalid/pipeline' })).toBe(expected);
  });

  it.each(nodeKinds)('classifies maximumIterations only for repeat, not %s by shape', (kind) => {
    const expected = kind === 'repeat' ? 'invalid_repeat_bound' : 'invalid_execution_plan';
    expect(validationCodeForRoot({ kind, maximumIterations: 0 })).toBe(expected);
  });

  it.each([
    ['sequence.children', { kind: 'sequence', children: [invalidTask] }],
    ['outcomeSwitch.source', { kind: 'outcomeSwitch', source: invalidTask }],
    ['outcomeSwitch.cases', { kind: 'outcomeSwitch', cases: { failed: invalidTask } }],
    ['outcomeSwitch.default', { kind: 'outcomeSwitch', default: invalidTask }],
    ['branch.cases', { kind: 'branch', cases: { failed: invalidTask } }],
    ['branch.default', { kind: 'branch', default: invalidTask }],
    ['parallel.branches', { kind: 'parallel', branches: { worker: invalidTask } }],
    ['consensus.participants', { kind: 'consensus', participants: { reviewer: invalidTask } }],
    ['map.body', { kind: 'map', body: invalidTask }],
    ['repeat.body', { kind: 'repeat', body: invalidTask }],
  ])('follows the canonical recursive slot %s', (_label, root) => {
    expect(validationCodeForRoot(root)).toBe('invalid_node_key');
  });

  it.each([
    ['children', [invalidTask]],
    ['source', invalidTask],
    ['cases', { failed: invalidTask }],
    ['default', invalidTask],
    ['branches', { worker: invalidTask }],
    ['participants', { reviewer: invalidTask }],
    ['body', invalidTask],
  ])('does not follow %s on the wrong parent kind', (property, child) => {
    expect(
      validationCodeForRoot({
        kind: 'end',
        status: 'succeeded',
        outcome: 'completed',
        [property]: child,
      }),
    ).toBe('invalid_execution_plan');
  });
});
