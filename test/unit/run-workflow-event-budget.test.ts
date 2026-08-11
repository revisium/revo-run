import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbos = vi.hoisted(() => ({
  workflowID: 'rr:run:v2:run-1',
  recv: vi.fn<(topic: string, options?: unknown) => Promise<unknown>>(),
  startWorkflow:
    vi.fn<(workflow: unknown, options: unknown) => (input: unknown) => Promise<unknown>>(),
}));

const stream = vi.hoisted(() => ({
  append: vi.fn<(event: unknown) => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
}));

vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: dbos }));

vi.mock('../../src/dbos/streams/run-event-stream.js', () => {
  class RunEventBudgetExceededError extends Error {
    readonly outcome: 'maximum_run_event_bytes_exceeded' | 'maximum_run_event_count_exceeded';

    constructor(outcome: RunEventBudgetExceededError['outcome']) {
      super(outcome);
      this.outcome = outcome;
    }
  }

  return {
    DbosRunEventStream: class {
      append = stream.append;
      close = stream.close;
    },
    RunEventBudgetExceededError,
  };
});

import { RunEventBudgetExceededError } from '../../src/dbos/streams/run-event-stream.js';
import type { RunExecutionWorkflow } from '../../src/dbos/workflows/run-execution-workflow.js';
import { createRunWorkflow } from '../../src/dbos/workflows/run-workflow.js';

const digest = (character: string): string => character.repeat(43);
const scopeWorkflowId = `rr:scope:v2:sc1_${digest('a')}`;
const nodeIdentity = {
  scopeId: `sc1_${digest('b')}`,
  authoredNodeId: `an1_${digest('c')}`,
  nodeInstanceId: `ni1_${digest('d')}`,
} as const;
const workflowInput = {
  contractVersion: 2,
  runId: 'run-1',
  admissionToken: digest('e'),
  executionPlan: {
    schemaVersion: 1,
    rootPipelineId: 'main',
    pipelines: {
      main: { root: { kind: 'end', status: 'succeeded', outcome: 'completed' } },
    },
    bindings: [],
    policies: {
      defaultTaskTimeoutMs: 1,
      maximumActiveNodeExecutions: 1,
      maximumNodeNestingDepth: 1,
      maximumSubpipelineDepth: 1,
      maximumTotalNodeExecutions: 1,
    },
  },
  input: null,
} as const;

describe('run workflow event budget result', () => {
  beforeEach(() => {
    dbos.workflowID = 'rr:run:v2:run-1';
    dbos.recv.mockReset();
    stream.append.mockReset().mockResolvedValue(undefined);
    stream.close.mockReset().mockResolvedValue(undefined);
  });

  it('returns the count failure without bypassing the exhausted budget for a terminal event', async () => {
    const execution = {
      workflowID: scopeWorkflowId,
      getResult: vi
        .fn<() => Promise<{ readonly status: 'succeeded'; readonly outcome: 'completed' }>>()
        .mockResolvedValue({ status: 'succeeded', outcome: 'completed' }),
    };
    dbos.startWorkflow.mockReturnValue(() => Promise.resolve(execution));
    dbos.recv.mockResolvedValueOnce({
      kind: 'event',
      event: { type: 'pipeline.branchDefaulted', data: nodeIdentity },
    });
    dbos.recv.mockResolvedValueOnce({ kind: 'scopeSettled', workflowId: scopeWorkflowId });
    stream.append.mockRejectedValueOnce(
      new RunEventBudgetExceededError('maximum_run_event_count_exceeded'),
    );

    await expect(
      createRunWorkflow(vi.fn<RunExecutionWorkflow>())(workflowInput),
    ).resolves.toStrictEqual({
      status: 'failed',
      outcome: 'maximum_run_event_count_exceeded',
    });
    expect(stream.append).toHaveBeenCalledOnce();
    expect(stream.close).toHaveBeenCalledOnce();
    expect(dbos.recv).toHaveBeenCalledTimes(2);
  });

  it('makes an oversized terminal event an authoritative failed result', async () => {
    const execution = {
      workflowID: scopeWorkflowId,
      getResult: vi
        .fn<() => Promise<{ readonly status: 'succeeded'; readonly outcome: 'completed' }>>()
        .mockResolvedValue({ status: 'succeeded', outcome: 'completed' }),
    };
    dbos.startWorkflow.mockReturnValue(() => Promise.resolve(execution));
    dbos.recv.mockResolvedValueOnce({ kind: 'scopeSettled', workflowId: scopeWorkflowId });
    stream.append.mockRejectedValueOnce(
      new RunEventBudgetExceededError('maximum_run_event_bytes_exceeded'),
    );

    await expect(
      createRunWorkflow(vi.fn<RunExecutionWorkflow>())(workflowInput),
    ).resolves.toStrictEqual({
      status: 'failed',
      outcome: 'maximum_run_event_bytes_exceeded',
    });
    expect(stream.append).toHaveBeenCalledOnce();
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it('does not mistake an ordinary pipeline outcome for a coordinator budget failure', async () => {
    const execution = {
      workflowID: scopeWorkflowId,
      getResult: vi
        .fn<
          () => Promise<{
            readonly status: 'failed';
            readonly outcome: 'maximum_run_event_count_exceeded';
          }>
        >()
        .mockResolvedValue({
          status: 'failed',
          outcome: 'maximum_run_event_count_exceeded',
        }),
    };
    dbos.startWorkflow.mockReturnValue(() => Promise.resolve(execution));
    dbos.recv.mockResolvedValueOnce({ kind: 'scopeSettled', workflowId: scopeWorkflowId });

    await expect(
      createRunWorkflow(vi.fn<RunExecutionWorkflow>())(workflowInput),
    ).resolves.toStrictEqual({
      status: 'failed',
      outcome: 'maximum_run_event_count_exceeded',
    });
    expect(stream.append).toHaveBeenCalledWith({
      type: 'run.failed',
      data: { outcome: 'maximum_run_event_count_exceeded' },
    });
  });

  it('propagates a non-budget coordinator failure after attempting stream cleanup', async () => {
    const execution = {
      workflowID: scopeWorkflowId,
      getResult: vi.fn<() => Promise<never>>(),
    };
    dbos.startWorkflow.mockReturnValue(() => Promise.resolve(execution));
    dbos.recv.mockRejectedValueOnce(new Error('coordinator failed'));

    await expect(createRunWorkflow(vi.fn<RunExecutionWorkflow>())(workflowInput)).rejects.toThrow(
      'coordinator failed',
    );
    expect(stream.append).not.toHaveBeenCalled();
    expect(stream.close).toHaveBeenCalledOnce();
  });
});
