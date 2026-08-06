import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import { RunExecutorResultSchema } from '../../src/contracts/executor/run-executor.js';
import { RunNodeExecutionSchema } from '../../src/contracts/executor/run-node-execution.js';
import { RunEventSchema } from '../../src/contracts/run/run-event.js';

const resultValidator = Schema.Compile(RunExecutorResultSchema);
const executionValidator = Schema.Compile(RunNodeExecutionSchema);
const eventValidator = Schema.Compile(RunEventSchema);

const request = {
  executionId: 'run-1:main/work:1',
  runId: 'run-1',
  path: 'main/work',
  pipelineId: 'main',
  nodePath: 'work',
  binding: {
    kind: 'script',
    target: { pipelineId: 'main', nodePath: 'work' },
    script: { id: 'example.run', version: '1.0.0' },
  },
  input: { subject: { kind: 'json', value: 'example' } },
} as const;

describe('executor durable contracts', () => {
  it('accepts a normalized node execution', () => {
    expect(
      executionValidator.Check({
        kind: 'runNodeExecution',
        request,
        result: {
          kind: 'completed',
          outcome: 'completed',
          output: { result: { kind: 'json', value: { accepted: true } } },
        },
      }),
    ).toBe(true);
  });

  it('rejects additional properties and malformed nested output', () => {
    expect(
      resultValidator.Check({
        kind: 'failed',
        error: { code: 'failed', message: 'Failed.' },
        x: 1,
      }),
    ).toBe(false);
    expect(
      resultValidator.Check({
        kind: 'completed',
        outcome: 'completed',
        output: { result: { kind: 'artifact', reference: { id: 'missing-fields' } } },
      }),
    ).toBe(false);
  });

  it('enforces identifier grammar at the executor boundary', () => {
    expect(
      resultValidator.Check({
        kind: 'inputResolutionFailed',
        error: { code: 'contains spaces', message: 'Invalid code.' },
      }),
    ).toBe(false);
  });
});

describe('run event durable contract', () => {
  it('accepts a cursor event and rejects unknown fields', () => {
    expect(
      eventValidator.Check({ cursor: '1', type: 'pipeline.invalidState', path: 'main/work' }),
    ).toBe(true);
    expect(eventValidator.Check({ cursor: '1', type: 'run.started', payload: {} })).toBe(false);
  });
});
