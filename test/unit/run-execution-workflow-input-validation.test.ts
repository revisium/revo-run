import { describe, expect, it } from 'vitest';

import { parseRunExecutionWorkflowInput } from '../../src/validation/run-execution-workflow-input.validator.js';

describe('run execution workflow input validation', () => {
  it('accepts a durable run reference', () => {
    const input = { runId: 'run_01', scopeId: `sc1_${'a'.repeat(43)}` };
    expect(parseRunExecutionWorkflowInput(input)).toStrictEqual({
      runId: 'run_01',
      scopeId: `sc1_${'a'.repeat(43)}`,
    });
  });

  it('rejects additional properties', () => {
    expect(() =>
      parseRunExecutionWorkflowInput({
        runId: 'run_01',
        scopeId: `sc1_${'a'.repeat(43)}`,
        unexpected: true,
      }),
    ).toThrow('Run execution workflow input is invalid.');
  });

  it('rejects an empty run ID', () => {
    expect(() =>
      parseRunExecutionWorkflowInput({ runId: '', scopeId: `sc1_${'a'.repeat(43)}` }),
    ).toThrow('Run execution workflow input is invalid.');
  });
});
