import { describe, expect, it } from 'vitest';

import { parseRunExecutionWorkflowInput } from '../../src/validation/run-execution-workflow-input.validator.js';

describe('run execution workflow input validation', () => {
  it('accepts a durable run reference', () => {
    expect(parseRunExecutionWorkflowInput({ runId: 'run_01' })).toStrictEqual({
      runId: 'run_01',
    });
  });

  it('rejects additional properties', () => {
    expect(() => parseRunExecutionWorkflowInput({ runId: 'run_01', unexpected: true })).toThrow(
      'Run execution workflow input is invalid.',
    );
  });

  it('rejects an empty run ID', () => {
    expect(() => parseRunExecutionWorkflowInput({ runId: '' })).toThrow(
      'Run execution workflow input is invalid.',
    );
  });
});
