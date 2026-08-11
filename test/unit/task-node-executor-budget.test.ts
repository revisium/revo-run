import assert from 'node:assert/strict';

import { describe, expect, it, vi } from 'vitest';

import type { TaskNode } from '../../src/contracts/pipeline/pipeline-node.js';
import type {
  ExecuteNodeEffect,
  PipelineExecutionContext,
} from '../../src/pipeline/interpreter/interpreter-context.js';
import type { PipelineEventSink } from '../../src/pipeline/interpreter/pipeline-event-sink.js';
import { TaskNodeExecutor } from '../../src/pipeline/interpreter/task-node-executor.js';
import { taskExecutionPlan } from '../support/execution-plan.fixture.js';

describe('task node executor budget backstop', () => {
  it('emits one stable invalid-state event and returns a terminal invalid result', async () => {
    const node: TaskNode = { kind: 'task', key: 'work' };
    const context: PipelineExecutionContext = {
      plan: taskExecutionPlan(),
      runId: 'run-1',
      scopeId: `sc1_${'a'.repeat(43)}`,
      runInput: null,
      pipelineId: 'main',
      pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
      runtimePath: 'main',
      outputs: new Map(),
      maximumParallelism: 1,
    };
    const execute = vi
      .fn<ExecuteNodeEffect>()
      .mockResolvedValue({ kind: 'executionLimitExceeded' });
    const write = vi.fn<PipelineEventSink['write']>().mockResolvedValue(undefined);
    const executor = new TaskNodeExecutor(execute, { write });

    await expect(executor.execute(node, context, 'work')).resolves.toEqual({
      kind: 'finished',
      result: { status: 'failed', outcome: 'invalid' },
    });
    expect(write).toHaveBeenCalledOnce();
    const event = write.mock.calls[0]?.[0];
    assert(event?.type === 'pipeline.invalidState');
    expect(event.data.scopeId).toBe(context.scopeId);
    expect(event.data.authoredNodeId).toMatch(/^an1_/);
    expect(event.data.nodeInstanceId).toMatch(/^ni1_/);
    expect(event.data.errorCode).toBe('maximum_total_node_executions_exceeded');
  });
});
