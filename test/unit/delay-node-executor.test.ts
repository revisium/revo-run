import { describe, expect, it, vi } from 'vitest';

import type { DelayNode } from '../../src/contracts/pipeline/pipeline-node.js';
import { DelayNodeExecutor } from '../../src/pipeline/interpreter/delay-node-executor.js';
import type {
  PipelineExecutionContext,
  WaitForDelay,
} from '../../src/pipeline/interpreter/interpreter-context.js';
import type { PipelineEventSink } from '../../src/pipeline/interpreter/pipeline-event-sink.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const node: DelayNode = { kind: 'delay', key: 'cooldown', durationMs: 250 };
const context: PipelineExecutionContext = {
  plan: terminalExecutionPlan(),
  runId: 'run-1',
  scopeId: `sc1_${'a'.repeat(43)}`,
  runInput: null,
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
  runtimePath: 'main',
  outputs: new Map(),
  maximumParallelism: 1,
};

describe('delay node executor', () => {
  it('continues only after the durable wait reports elapsed', async () => {
    const wait = vi.fn<WaitForDelay>().mockResolvedValue('elapsed');
    const write = vi.fn<PipelineEventSink['write']>();

    await expect(
      new DelayNodeExecutor(wait, { write }).execute(node, context, 'cooldown'),
    ).resolves.toEqual({ kind: 'continued', outcome: 'completed', path: 'main/cooldown' });
    expect(wait).toHaveBeenCalledWith(250);
    expect(write).not.toHaveBeenCalled();
  });

  it('emits the exact cancellation event before returning cancellation', async () => {
    const wait = vi.fn<WaitForDelay>().mockResolvedValue('cancelled');
    const write = vi.fn<PipelineEventSink['write']>().mockResolvedValue(undefined);

    await expect(
      new DelayNodeExecutor(wait, { write }).execute(node, context, 'cooldown'),
    ).resolves.toEqual({
      kind: 'finished',
      provenance: 'terminal',
      result: { status: 'cancelled', outcome: 'cancelled' },
    });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      type: 'delay.cancelled',
      data: { scopeId: context.scopeId },
    });
  });

  it('does not bypass a failure fence to emit cancellation', async () => {
    const wait = vi.fn<WaitForDelay>().mockResolvedValue('failed');
    const write = vi.fn<PipelineEventSink['write']>();

    await expect(
      new DelayNodeExecutor(wait, { write }).execute(node, context, 'cooldown'),
    ).resolves.toEqual({
      kind: 'finished',
      provenance: 'terminal',
      result: { status: 'failed', outcome: 'event_budget_exceeded' },
    });
    expect(write).not.toHaveBeenCalled();
  });
});
