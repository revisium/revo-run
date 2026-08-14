import { describe, expect, it, vi } from 'vitest';

import type { RepeatNode } from '../../src/contracts/pipeline/pipeline-node.js';
import type { PipelineExecutionContext } from '../../src/pipeline/interpreter/interpreter-context.js';
import type { PipelineEventSink } from '../../src/pipeline/interpreter/pipeline-event-sink.js';
import { RepeatNodeExecutor } from '../../src/pipeline/interpreter/repeat-node-executor.js';
import type { RepeatIterationRunner } from '../../src/pipeline/repeat/repeat-iteration-runner.js';
import { agentBinding, executionPlan, task } from '../dsl/pipeline-builder.js';

const repeat = (overrides: Partial<RepeatNode> = {}): RepeatNode => ({
  kind: 'repeat',
  key: 'review',
  maximumIterations: 2,
  continueOn: ['rejected'],
  completeOn: ['approved'],
  initialInput: { change: { kind: 'runInput', path: '/change' } },
  nextInput: {
    change: { kind: 'iterationOutput', outputKey: 'result', path: '/change' },
    previous: { kind: 'iterationInput', path: '/change' },
  },
  body: task('work'),
  ...overrides,
});

const contextFor = (node: RepeatNode): PipelineExecutionContext => ({
  plan: executionPlan(node, { bindings: [agentBinding('review/work', 'reviewer')] }),
  runId: 'run-1',
  scopeId: `sc1_${'a'.repeat(43)}`,
  runInput: { change: 'initial' },
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
  runtimePath: 'main',
  outputs: new Map(),
  maximumParallelism: 1,
});

const eventSink = () => {
  const write = vi.fn<PipelineEventSink['write']>().mockResolvedValue(undefined);
  return { write };
};

describe('repeat node executor', () => {
  it('uses initial input then the immediately previous input and output', async () => {
    const node = repeat();
    const context = contextFor(node);
    const execute = vi
      .fn<RepeatIterationRunner['execute']>()
      .mockResolvedValueOnce({
        kind: 'continued',
        ordinal: 1,
        outcome: 'rejected',
        output: { result: { kind: 'json', value: { change: 'revision-2' } } },
      })
      .mockResolvedValueOnce({ kind: 'continued', ordinal: 2, outcome: 'approved' });

    await expect(
      new RepeatNodeExecutor({ execute }, eventSink()).execute(node, context, 'review'),
    ).resolves.toEqual({ kind: 'continued', outcome: 'completed', path: 'main/review' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0].input).toEqual({
      change: { kind: 'json', value: 'initial' },
    });
    expect(execute.mock.calls[1]?.[0].input).toEqual({
      change: { kind: 'json', value: 'revision-2' },
      previous: { kind: 'json', value: 'initial' },
    });
    expect(context.outputs.has('review')).toBe(false);
  });

  it('forwards and records only a present final body output', async () => {
    const node = repeat({ maximumIterations: 1 });
    const context = contextFor(node);
    const output = { result: { kind: 'json' as const, value: { approved: true } } };
    const execute = vi
      .fn<RepeatIterationRunner['execute']>()
      .mockResolvedValue({ kind: 'continued', ordinal: 1, outcome: 'approved', output });

    await expect(
      new RepeatNodeExecutor({ execute }, eventSink()).execute(node, context, 'review'),
    ).resolves.toEqual({
      kind: 'continued',
      outcome: 'completed',
      path: 'main/review',
      output,
    });
    expect(context.outputs.get('review')).toEqual(output);
  });

  it('exhausts exactly once at the bound and forwards optional output', async () => {
    const node = repeat({ nextInput: {} });
    const context = contextFor(node);
    const events = eventSink();
    const finalOutput = { result: { kind: 'json' as const, value: 'final' } };
    const execute = vi
      .fn<RepeatIterationRunner['execute']>()
      .mockResolvedValueOnce({ kind: 'continued', ordinal: 1, outcome: 'rejected' })
      .mockResolvedValueOnce({
        kind: 'continued',
        ordinal: 2,
        outcome: 'rejected',
        output: finalOutput,
      });

    await expect(
      new RepeatNodeExecutor({ execute }, events).execute(node, context, 'review'),
    ).resolves.toEqual({
      kind: 'continued',
      outcome: 'exhausted',
      path: 'main/review',
      output: finalOutput,
    });
    expect(events.write).toHaveBeenCalledOnce();
    expect(events.write.mock.calls[0]?.[0]).toMatchObject({
      type: 'repeat.exhausted',
      data: { scopeId: context.scopeId },
    });
  });

  it.each([1, 2])(
    'fails an unmatched outcome at ordinal %i without exhaustion',
    async (ordinal) => {
      const node = repeat();
      const context = contextFor(node);
      const events = eventSink();
      const execute = vi.fn<RepeatIterationRunner['execute']>();
      for (let current = 1; current < ordinal; current += 1) {
        execute.mockResolvedValueOnce({
          kind: 'continued',
          ordinal: current,
          outcome: 'rejected',
          output: { result: { kind: 'json', value: { change: 'next' } } },
        });
      }
      execute.mockResolvedValueOnce({ kind: 'continued', ordinal, outcome: 'unexpected' });

      await expect(
        new RepeatNodeExecutor({ execute }, events).execute(node, context, 'review'),
      ).resolves.toEqual({
        kind: 'finished',
        provenance: 'terminal',
        result: { status: 'failed', outcome: 'invalid' },
      });
      expect(events.write).toHaveBeenCalledOnce();
      expect(events.write.mock.calls[0]?.[0]).toMatchObject({
        type: 'pipeline.invalidState',
        data: { errorCode: 'unhandled_node_outcome' },
      });
    },
  );

  it('fails an explicit next iteration output reference when output is absent', async () => {
    const node = repeat();
    const context = contextFor(node);
    const events = eventSink();
    const execute = vi
      .fn<RepeatIterationRunner['execute']>()
      .mockResolvedValue({ kind: 'continued', ordinal: 1, outcome: 'rejected' });

    await expect(
      new RepeatNodeExecutor({ execute }, events).execute(node, context, 'review'),
    ).resolves.toEqual({ kind: 'continued', outcome: 'failed', path: 'main/review' });
    expect(execute).toHaveBeenCalledOnce();
    expect(events.write.mock.calls[0]?.[0]).toMatchObject({
      type: 'inputResolution.failed',
      data: { errorCode: 'input_source_unavailable' },
    });
  });

  it('bypasses outcome policy and later ordinals for terminal cancellation', async () => {
    const node = repeat({ completeOn: ['cancelled'], continueOn: ['cancelled'] });
    const context = contextFor(node);
    const execute = vi.fn<RepeatIterationRunner['execute']>().mockResolvedValue({
      kind: 'terminal',
      ordinal: 1,
      result: { status: 'cancelled', outcome: 'cancelled' },
    });

    await expect(
      new RepeatNodeExecutor({ execute }, eventSink()).execute(node, context, 'review'),
    ).resolves.toEqual({
      kind: 'finished',
      provenance: 'terminal',
      result: { status: 'cancelled', outcome: 'cancelled' },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('preserves exact terminal failure instead of matching outer completeOn', async () => {
    const node = repeat({ completeOn: ['invalid'], continueOn: ['invalid'] });
    const context = contextFor(node);
    const result = {
      status: 'failed' as const,
      outcome: 'invalid',
      output: { result: { kind: 'json' as const, value: 'diagnostic' } },
    };
    const execute = vi.fn<RepeatIterationRunner['execute']>().mockResolvedValue({
      kind: 'terminal',
      ordinal: 1,
      result,
    });

    await expect(
      new RepeatNodeExecutor({ execute }, eventSink()).execute(node, context, 'review'),
    ).resolves.toEqual({ kind: 'finished', provenance: 'terminal', result });
    expect(execute).toHaveBeenCalledOnce();
    expect(context.outputs.has('review')).toBe(false);
  });
});
