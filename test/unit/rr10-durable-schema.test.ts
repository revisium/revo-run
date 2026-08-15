import { describe, expect, it } from 'vitest';

import { parseDurableMapControlDecision } from '../../src/validation/map-control-decision.validator.js';
import { parseMapItemResult } from '../../src/validation/map-item-result.validator.js';
import {
  MapItemWorkflowArgumentsParser,
  parseMapItemWorkflowInput,
} from '../../src/validation/map-item-workflow-input.validator.js';

const scopeId = `sc1_${'a'.repeat(43)}`;
const parentScopeId = `sc1_${'b'.repeat(43)}`;
const nodeInstanceId = `ni1_${'c'.repeat(43)}`;
const workflowId = `rr:scope:${scopeId}`;
const parentWorkflowId = `rr:scope:${parentScopeId}`;
const rawKey = `raw/key%[${String.fromCharCode(0xd800)}`;
const input = {
  runId: 'run-1',
  scopeId,
  parentScopeId,
  mapNodeInstanceId: nodeInstanceId,
  sourceIndex: 0,
  itemKey: rawKey,
  item: { key: rawKey, payload: [null, true, 1] },
  node: { kind: 'task', key: 'work' },
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
  runtimePath: 'main/repositories[raw%2Fkey%25%5B%uD800]',
  parentPath: 'repositories',
  inheritedOutputs: [],
  maximumParallelism: 2,
  parentWorkflowId,
  disposition: 'execute',
  startFence: {
    directive: 'start',
    requestId: `request:${workflowId}`,
    admissionId: `admission:${workflowId}`,
    workflowId,
  },
} as const;

const decision = {
  scopeId: parentScopeId,
  nodeInstanceId,
  control: 'failureDecided',
  decisiveItemKey: 'a',
  summaryEligibleItemKeys: ['a'],
  admitted: [{ sourceIndex: 0, itemKey: 'a' }],
  remaining: [{ sourceIndex: 1, itemKey: 'b', disposition: 'cancel' }],
} as const;

describe('RR-10 durable map schemas', () => {
  it('accepts an isolated UTF-16 surrogate in the raw item key', () => {
    expect(parseMapItemWorkflowInput(input)).toEqual(input);
  });

  it('accepts the exact single-argument workflow tuple', () => {
    expect(MapItemWorkflowArgumentsParser.parse([input])).toEqual([input]);
  });

  it('accepts the settlement-only map item disposition', () => {
    expect(parseMapItemWorkflowInput({ ...input, disposition: 'settlementOnly' })).toMatchObject({
      disposition: 'settlementOnly',
    });
  });

  it.each([
    {
      name: 'settlement-only',
      value: { kind: 'settlementOnly', sourceIndex: 0, itemKey: 'a' },
    },
    {
      name: 'continued',
      value: { kind: 'continued', sourceIndex: 0, itemKey: 'a', outcome: 'completed' },
    },
    {
      name: 'authored end',
      value: {
        kind: 'authoredEnd',
        sourceIndex: 0,
        itemKey: 'a',
        result: { status: 'succeeded', outcome: 'completed' },
      },
    },
    {
      name: 'terminal',
      value: {
        kind: 'terminal',
        sourceIndex: 0,
        itemKey: 'a',
        result: { status: 'failed', outcome: 'invalid' },
      },
    },
  ])('accepts the $name result variant', ({ value }) => {
    expect(parseMapItemResult(value)).toMatchObject({ kind: value.kind });
  });

  it.each([
    { name: 'additional property', value: { ...input, protocolVersion: 1 } },
    { name: 'invalid map identity', value: { ...input, mapNodeInstanceId: 'node-1' } },
    { name: 'empty raw key', value: { ...input, itemKey: '' } },
    { name: 'invalid parent path', value: { ...input, parentPath: 'repositories[0]' } },
    { name: 'invalid disposition', value: { ...input, disposition: 'skip' } },
    { name: 'invalid item JSON', value: { ...input, item: undefined } },
  ])('rejects workflow input with $name', ({ value }) => {
    expect(() => parseMapItemWorkflowInput(value)).toThrow('Map item workflow input is invalid.');
  });

  it.each([
    { kind: 'continued', sourceIndex: 0, itemKey: '', outcome: 'completed' },
    { kind: 'continued', sourceIndex: 0, itemKey: 'a', outcome: 'not valid' },
    { kind: 'settlementOnly', sourceIndex: 0, itemKey: 'a', extra: true },
    {
      kind: 'terminal',
      sourceIndex: 0,
      itemKey: 'a',
      result: { status: 'succeeded', outcome: 'completed' },
    },
  ])('rejects malformed settlement %#', (value) => {
    expect(() => parseMapItemResult(value)).toThrow('Map item workflow result is invalid.');
  });

  it.each([
    { name: 'failure-decided', value: decision },
    {
      name: 'all-settled',
      value: {
        scopeId: decision.scopeId,
        nodeInstanceId: decision.nodeInstanceId,
        control: 'allSettled',
        summaryEligibleItemKeys: ['a', 'b'],
        admitted: [
          { sourceIndex: 0, itemKey: 'a' },
          { sourceIndex: 1, itemKey: 'b' },
        ],
        remaining: [],
      },
    },
  ])('accepts the exact $name decision shape', ({ value }) => {
    expect(parseDurableMapControlDecision(value)).toEqual(value);
  });

  it.each([
    { ...decision, kind: 'failureDecided' },
    { ...decision, extra: true },
    { ...decision, scopeId: 'scope-1' },
    { ...decision, summaryEligibleItemKeys: ['a', 'a'] },
    { ...decision, remaining: [{ sourceIndex: 1, itemKey: 'b', disposition: 'skip' }] },
    { ...decision, decisiveItemKey: '' },
  ])('rejects malformed decision %#', (value) => {
    expect(() => parseDurableMapControlDecision(value)).toThrow(
      'Stored map control decision is invalid.',
    );
  });
});
