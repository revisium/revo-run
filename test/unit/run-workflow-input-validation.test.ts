import { describe, expect, it } from 'vitest';

import { parseRunWorkflowInput } from '../../src/validation/parse-run-workflow-data.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const validInput = () => ({
  runId: 'Run_1',
  admissionToken: 'a'.repeat(43),
  executionPlan: terminalExecutionPlan(),
  input: null,
});

describe('durable run workflow arguments', () => {
  it('accepts the complete create-only admission contract', () => {
    const input = validInput();
    expect(parseRunWorkflowInput([input])).toEqual(input);
  });

  it('rejects a noncanonical protocol selector', () => {
    expect(() => parseRunWorkflowInput([{ ...validInput(), protocolSelector: 'foreign' }])).toThrow(
      'Run workflow input is invalid.',
    );
  });

  it.each([
    { ...validInput(), admissionToken: 'short' },
    { ...validInput(), runId: 'run:reserved' },
    { ...validInput(), unexpected: true },
    (() => {
      const { admissionToken: _admissionToken, ...missingToken } = validInput();
      return missingToken;
    })(),
  ])('rejects malformed durable arguments', (input) => {
    expect(() => parseRunWorkflowInput([input])).toThrow('Run workflow input is invalid.');
  });
});
