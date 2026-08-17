import { describe, expect, it } from 'vitest';

import { parseRepeatIterationResult } from '../../src/validation/repeat-iteration-result.validator.js';
import {
  parseRepeatIterationWorkflowInput,
  RepeatIterationWorkflowArgumentsParser,
} from '../../src/validation/repeat-iteration-workflow-input.validator.js';

const scopeId = `sc1_${'a'.repeat(43)}`;
const parentScopeId = `sc1_${'b'.repeat(43)}`;
const workflowId = `rr:scope:${scopeId}`;
const parentWorkflowId = `rr:scope:${parentScopeId}`;
const input = {
  runId: 'run-1',
  scopeId,
  parentScopeId,
  ordinal: 1,
  node: { kind: 'task', key: 'work' },
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
  iterationInput: { change: { kind: 'json', value: { revision: 1 } } },
  runtimePath: 'main/review[1]',
  parentPath: 'review',
  inheritedOutputs: [],
  maximumParallelism: 2,
  parentWorkflowId,
  startFence: {
    directive: 'start',
    requestId: `request:${workflowId}`,
    admissionId: `admission:${workflowId}`,
    workflowId,
  },
} as const;

describe('durable repeat schema', () => {
  it.each([
    { kind: 'task', key: 'work' },
    {
      kind: 'parallel',
      key: 'group',
      branches: { a: { kind: 'task', key: 'a' } },
      join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
    },
    { kind: 'subpipeline', key: 'phase', pipelineId: 'child' },
    {
      kind: 'repeat',
      key: 'nested',
      maximumIterations: 1,
      continueOn: ['retry'],
      completeOn: ['completed'],
      body: { kind: 'task', key: 'nested-work' },
    },
  ] as const)('accepts the approved $kind body contract', (node) => {
    expect(parseRepeatIterationWorkflowInput({ ...input, node })).toMatchObject({ node });
  });

  it('accepts the canonical iteration input and optional-output settlements', () => {
    expect(parseRepeatIterationWorkflowInput(input)).toEqual(input);
    expect(RepeatIterationWorkflowArgumentsParser.parse([input])).toEqual([input]);
    expect(
      parseRepeatIterationResult({ kind: 'continued', ordinal: 1, outcome: 'completed' }),
    ).toEqual({ kind: 'continued', ordinal: 1, outcome: 'completed' });
    expect(
      parseRepeatIterationResult({
        kind: 'continued',
        ordinal: 1,
        outcome: 'completed',
        output: { result: { kind: 'json', value: null } },
      }),
    ).toEqual({
      kind: 'continued',
      ordinal: 1,
      outcome: 'completed',
      output: { result: { kind: 'json', value: null } },
    });
    expect(
      parseRepeatIterationResult({
        kind: 'terminal',
        ordinal: 1,
        result: { status: 'failed', outcome: 'invalid' },
      }),
    ).toEqual({
      kind: 'terminal',
      ordinal: 1,
      result: { status: 'failed', outcome: 'invalid' },
    });
    expect(
      parseRepeatIterationResult({
        kind: 'terminal',
        ordinal: 1,
        result: {
          status: 'failed',
          outcome: 'invalid',
          output: { result: { kind: 'json', value: 'diagnostic' } },
        },
      }),
    ).toMatchObject({ kind: 'terminal', result: { status: 'failed' } });
    expect(
      parseRepeatIterationResult({
        kind: 'terminal',
        ordinal: 1,
        result: { status: 'cancelled', outcome: 'cancelled' },
      }),
    ).toEqual({
      kind: 'terminal',
      ordinal: 1,
      result: { status: 'cancelled', outcome: 'cancelled' },
    });
  });

  it.each([
    { name: 'additional property', value: { ...input, protocolVersion: 2 } },
    {
      name: 'malformed nested iteration value',
      value: { ...input, iterationInput: { change: { kind: 'json', value: undefined } } },
    },
    { name: 'invalid pipeline identifier', value: { ...input, pipelineId: 'not valid' } },
    {
      name: 'unsupported body kind',
      value: { ...input, node: { kind: 'end', status: 'succeeded', outcome: 'completed' } },
    },
  ])('rejects iteration input with $name', ({ value }) => {
    expect(() => parseRepeatIterationWorkflowInput(value)).toThrow(
      'Repeat iteration workflow input is invalid.',
    );
  });

  it.each([
    { kind: 'continued', ordinal: 1, outcome: 'not valid' },
    { kind: 'continued', ordinal: 1, outcome: 'completed', output: null },
    { kind: 'continued', ordinal: 1, outcome: 'completed', extra: true },
    { kind: 'terminal', ordinal: 1, result: { status: 'succeeded', outcome: 'completed' } },
    {
      kind: 'terminal',
      ordinal: 1,
      result: { status: 'cancelled', outcome: 'cancelled', output: {} },
    },
    { kind: 'terminal', ordinal: 1, result: { status: 'failed', outcome: 'invalid' }, extra: true },
    { kind: 'terminal', ordinal: 0, result: { status: 'cancelled', outcome: 'cancelled' } },
    { status: 'completed', ordinal: 1, outcome: 'completed' },
    { status: 'cancelled', ordinal: 1 },
  ])('rejects malformed iteration settlement %#', (value) => {
    expect(() => parseRepeatIterationResult(value)).toThrow('Repeat iteration result is invalid.');
  });
});
