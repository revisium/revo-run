import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import {
  RunExecutorRequestSchema,
  RunExecutorResultSchema,
} from '../../src/contracts/executor/run-executor.js';
import { RunNodeExecutionSchema } from '../../src/contracts/executor/run-node-execution.js';
import { RunEventSchema } from '../../src/contracts/run/run-event.js';

const resultValidator = Schema.Compile(RunExecutorResultSchema);
const requestValidator = Schema.Compile(RunExecutorRequestSchema);
const executionValidator = Schema.Compile(RunNodeExecutionSchema);
const eventValidator = Schema.Compile(RunEventSchema);

const request = {
  runId: 'run-1',
  authoredNodeId: `an1_${'a'.repeat(43)}`,
  scopeId: `sc1_${'b'.repeat(43)}`,
  nodeInstanceId: `ni1_${'c'.repeat(43)}`,
  attemptId: `at1_${'d'.repeat(43)}`,
  attemptOrdinal: 1,
  displayPath: 'main/work',
  pipelineId: 'main',
  nodePath: 'work',
  binding: {
    kind: 'script',
    target: { pipelineId: 'main', nodePath: 'work' },
    script: { id: 'example.run', revision: 1 },
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

  it('rejects path aliases and invalid attempt identity', () => {
    expect(
      executionValidator.Check({
        kind: 'runNodeExecution',
        request: { ...request, path: request.displayPath },
        result: { kind: 'completed', outcome: 'completed' },
      }),
    ).toBe(false);
    expect(
      executionValidator.Check({
        kind: 'runNodeExecution',
        request: { ...request, attemptOrdinal: 0 },
        result: { kind: 'completed', outcome: 'completed' },
      }),
    ).toBe(false);
  });

  it('rejects invalid pipeline-relative node paths directly and in stored executions', () => {
    const invalidRequest = { ...request, nodePath: 'invalid//path' };

    expect(requestValidator.Check(invalidRequest)).toBe(false);
    expect(
      executionValidator.Check({
        kind: 'runNodeExecution',
        request: invalidRequest,
        result: { kind: 'completed', outcome: 'completed' },
      }),
    ).toBe(false);
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
      eventValidator.Check({
        cursor: 'run-1:1',
        timestamp: '2026-08-10T12:34:56.789Z',
        type: 'pipeline.invalidState',
        data: {
          scopeId: request.scopeId,
          authoredNodeId: request.authoredNodeId,
          nodeInstanceId: request.nodeInstanceId,
          errorCode: 'terminal_not_reached',
        },
      }),
    ).toBe(true);
    expect(
      eventValidator.Check({
        cursor: 'run-1:1',
        timestamp: '2026-08-10T12:34:56.789Z',
        type: 'run.started',
        data: {},
      }),
    ).toBe(false);
  });
});
