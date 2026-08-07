import { describe, expect, it } from 'vitest';

import { parseParallelBranchWorkflowInput } from '../../src/validation/parallel-branch-workflow-input.validator.js';

const workflowInput = () => ({
  runId: 'run_01',
  branchKey: 'security',
  node: { kind: 'task', key: 'scan' },
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: {} } },
  runtimePath: 'main',
  parentPath: 'checks',
  inheritedOutputs: [],
  maximumParallelism: 2,
});

describe('parallel branch workflow input validation', () => {
  it('accepts a complete durable input', () => {
    const input = workflowInput();

    expect(parseParallelBranchWorkflowInput(input)).toStrictEqual(input);
  });

  it('rejects additional properties', () => {
    expect(() =>
      parseParallelBranchWorkflowInput({ ...workflowInput(), unexpected: true }),
    ).toThrow('Parallel branch workflow input is invalid.');
  });

  it('rejects malformed nested pipeline nodes', () => {
    expect(() =>
      parseParallelBranchWorkflowInput({
        ...workflowInput(),
        node: { kind: 'task', key: 'invalid/key' },
      }),
    ).toThrow('Parallel branch workflow input is invalid.');
  });

  it('rejects identifiers outside the contract grammar', () => {
    expect(() =>
      parseParallelBranchWorkflowInput({ ...workflowInput(), branchKey: 'invalid/key' }),
    ).toThrow('Parallel branch workflow input is invalid.');
  });
});
