import { describe, expect, it, vi } from 'vitest';

import type { MapNode } from '../../src/contracts/pipeline/pipeline-node.js';
import type { PipelineExecutionContext } from '../../src/pipeline/interpreter/interpreter-context.js';
import { MapNodeExecutor } from '../../src/pipeline/interpreter/map-node-executor.js';
import type { PipelineEventSink } from '../../src/pipeline/interpreter/pipeline-event-sink.js';
import type { MapItemRunner } from '../../src/pipeline/map/map-item-runner.js';
import { executionPlan, task } from '../dsl/pipeline-builder.js';

const mapNode = (overrides: Partial<MapNode> = {}): MapNode => ({
  kind: 'map',
  key: 'repositories',
  items: { kind: 'runInput', path: '/items' },
  itemKeyPath: '/key',
  maximumItems: 3,
  concurrency: 2,
  failure: { kind: 'collect' },
  body: task('review'),
  ...overrides,
});

const contextFor = (node: MapNode, runInput: PipelineExecutionContext['runInput']) => ({
  plan: executionPlan(node),
  runId: 'run-1',
  scopeId: `sc1_${'a'.repeat(43)}`,
  runInput,
  pipelineId: 'main',
  pipelineInput: { kind: 'value' as const, value: { kind: 'json' as const, value: null } },
  runtimePath: 'main',
  outputs: new Map(),
  maximumParallelism: 2,
});

const harness = () => {
  const execute = vi.fn<MapItemRunner['execute']>().mockResolvedValue({
    kind: 'continued',
    outcome: 'completed',
    output: {
      summary: {
        kind: 'json',
        value: { totalItems: 0, completedItems: 0, failedItems: 0, failures: [] },
      },
    },
  });
  const write = vi.fn<PipelineEventSink['write']>().mockResolvedValue(undefined);
  return { execute, write, executor: new MapNodeExecutor({ execute }, { write }) };
};

const expectRejectedBeforeAdmission = async (
  runInput: PipelineExecutionContext['runInput'],
  expectedType: string,
  expectedErrorCode?: string,
  node = mapNode(),
) => {
  const { execute, write, executor } = harness();
  await executor.execute(node, contextFor(node, runInput), 'repositories');
  expect(execute).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledOnce();
  expect(write.mock.calls[0]?.[0]).toMatchObject({
    type: expectedType,
    ...(expectedErrorCode === undefined ? {} : { data: { errorCode: expectedErrorCode } }),
  });
};

describe('RR-10 map preflight', () => {
  it('applies resolution, shape, maximum, then source-order key validation precedence', async () => {
    expect.hasAssertions();
    await expectRejectedBeforeAdmission(
      {},
      'inputResolution.failed',
      'json_pointer_not_found',
      mapNode({ maximumItems: 0, itemKeyPath: '/missing' }),
    );
    await expectRejectedBeforeAdmission(
      { items: { key: 'not-an-array' } },
      'pipeline.invalidState',
      'map_items_not_array',
      mapNode({ maximumItems: 0, itemKeyPath: '/missing' }),
    );
    await expectRejectedBeforeAdmission(
      { items: [{}, {}] },
      'map.limitExceeded',
      undefined,
      mapNode({ maximumItems: 1, itemKeyPath: '/missing' }),
    );
    await expectRejectedBeforeAdmission(
      { items: [{}, { key: 4 }] },
      'pipeline.invalidState',
      'map_item_key_not_found',
    );
  });

  it.each([
    { item: {}, errorCode: 'map_item_key_not_found' },
    { item: { key: 0 }, errorCode: 'invalid_map_item_key' },
    { item: { key: '' }, errorCode: 'invalid_map_item_key' },
  ])('rejects $errorCode before admitting any child', async ({ item, errorCode }) => {
    expect.hasAssertions();
    await expectRejectedBeforeAdmission({ items: [item] }, 'pipeline.invalidState', errorCode);
  });

  it('compares duplicate keys as exact raw strings', async () => {
    await expectRejectedBeforeAdmission(
      { items: [{ key: 'same' }, { key: 'same' }] },
      'pipeline.invalidState',
      'duplicate_map_item_key',
    );

    const node = mapNode({ maximumItems: 4 });
    const { execute, executor } = harness();
    const rawKeys = ['A', '%41', '\ud800', '\ud801'];
    await executor.execute(
      node,
      contextFor(node, { items: rawKeys.map((key) => ({ key })) }),
      'repositories',
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].items.map(({ itemKey }) => itemKey)).toEqual(rawKeys);
  });

  it.each([
    { name: 'empty', items: [] },
    { name: 'single', items: [{ key: 'one' }] },
    { name: 'many', items: [{ key: 'one' }, { key: 'two' }, { key: 'three' }] },
  ])('admits the $name valid cardinality exactly once', async ({ items }) => {
    const node = mapNode();
    const context = contextFor(node, { items });
    const { execute, executor } = harness();
    await executor.execute(node, context, 'repositories');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].items).toEqual(
      items.map((value, sourceIndex) => ({ sourceIndex, itemKey: value.key, value })),
    );
    expect(context.outputs.get('repositories')).toEqual({
      summary: {
        kind: 'json',
        value: { totalItems: 0, completedItems: 0, failedItems: 0, failures: [] },
      },
    });
  });
});
