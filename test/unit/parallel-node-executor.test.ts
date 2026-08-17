import { describe, expect, it, vi } from 'vitest';

import type { ParallelNode } from '../../src/contracts/pipeline/pipeline-node.js';
import type { PipelineExecutionContext } from '../../src/pipeline/interpreter/interpreter-context.js';
import { ParallelNodeExecutor } from '../../src/pipeline/interpreter/parallel-node-executor.js';
import type { PipelineEventSink } from '../../src/pipeline/interpreter/pipeline-event-sink.js';
import type { ParallelBranchRunner } from '../../src/pipeline/parallel/parallel-branch-runner.js';
import { executionPlan, task } from '../dsl/pipeline-builder.js';

const node: ParallelNode = {
  kind: 'parallel',
  key: 'review',
  branches: { left: task('left'), right: task('right') },
  join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
};

const contextFor = (): PipelineExecutionContext => ({
  plan: executionPlan(node),
  runId: 'run-1',
  scopeId: `sc1_${'a'.repeat(43)}`,
  runInput: null,
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
  runtimePath: 'main',
  outputs: new Map(),
  maximumParallelism: 2,
});

const harness = (execute: ParallelBranchRunner['execute']) => {
  const write = vi.fn<PipelineEventSink['write']>().mockResolvedValue(undefined);
  return { write, executor: new ParallelNodeExecutor({ execute }, { write }) };
};

describe('parallel node executor', () => {
  it('returns a terminal result without writing events or outputs', async () => {
    const context = contextFor();
    const { write, executor } = harness(async () => ({
      kind: 'terminal',
      result: { status: 'failed', outcome: 'event_budget_exceeded' },
    }));

    await expect(executor.execute(node, context, 'review')).resolves.toEqual({
      kind: 'finished',
      provenance: 'terminal',
      result: { status: 'failed', outcome: 'event_budget_exceeded' },
    });
    expect(write).not.toHaveBeenCalled();
    expect(context.outputs.size).toBe(0);
  });

  it('merges eligible branch outputs on a completed join without an event', async () => {
    const context = contextFor();
    const { write, executor } = harness(async () => ({
      kind: 'continued',
      outcome: 'completed',
      eligibleResults: [
        {
          key: 'left',
          outcome: 'completed',
          outputs: [['review/left', { value: { kind: 'json', value: 1 } }]],
        },
      ],
    }));

    await expect(executor.execute(node, context, 'review')).resolves.toMatchObject({
      kind: 'continued',
      outcome: 'completed',
    });
    expect(context.outputs.get('review/left')).toEqual({ value: { kind: 'json', value: 1 } });
    expect(write).not.toHaveBeenCalled();
  });

  it('merges outputs and writes parallel.joinFailed on a failed join', async () => {
    const context = contextFor();
    const { write, executor } = harness(async () => ({
      kind: 'continued',
      outcome: 'failed',
      eligibleResults: [
        {
          key: 'left',
          outcome: 'failed',
          outputs: [['review/left', { value: { kind: 'json', value: 0 } }]],
        },
      ],
    }));

    await expect(executor.execute(node, context, 'review')).resolves.toMatchObject({
      kind: 'continued',
      outcome: 'failed',
    });
    expect(context.outputs.get('review/left')).toEqual({ value: { kind: 'json', value: 0 } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toMatchObject({ type: 'parallel.joinFailed' });
  });
});
