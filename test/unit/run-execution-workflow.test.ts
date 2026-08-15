import { beforeEach, describe, expect, it, vi } from 'vitest';

const createPipelineExecution = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());
const loadRunWorkflowInput = vi.hoisted(() => vi.fn<(runId: string) => Promise<unknown>>());
const dbos = vi.hoisted(() => ({
  getWorkflowStatus: vi.fn<(workflowId: string) => Promise<unknown>>(),
  recv: vi.fn<(topic: string, options?: unknown) => Promise<unknown>>(),
  send: vi.fn<(workflowId: string, message: unknown, topic: string) => Promise<void>>(),
  workflowID: `rr:scope:sc1_${'a'.repeat(43)}`,
}));

vi.mock('../../src/dbos/workflows/create-pipeline-execution.js', () => ({
  createPipelineExecution,
}));
vi.mock('../../src/dbos/workflows/load-run-workflow-input.js', () => ({ loadRunWorkflowInput }));
vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>();
  return { ...actual, DBOS: dbos };
});

import { RunCoordinatorClient } from '../../src/dbos/coordination/run-coordinator-client.js';
import { ScopeCancellationRegistry } from '../../src/dbos/coordination/scope-cancellation-registry.js';
import {
  scopeDirectiveTopic,
  scopeReplyTopic,
  scopeSettlementTopic,
} from '../../src/dbos/dbos-names.js';
import { ProviderCallRegistry } from '../../src/dbos/executor/provider-call-registry.js';
import { RunExecutorProvider } from '../../src/dbos/executor/run-executor-provider.js';
import { MapItemWorkflowProvider } from '../../src/dbos/workflows/map-item-workflow-provider.js';
import { ParallelBranchWorkflowProvider } from '../../src/dbos/workflows/parallel-branch-workflow-provider.js';
import { RepeatIterationWorkflowProvider } from '../../src/dbos/workflows/repeat-iteration-workflow-provider.js';
import { createRunExecutionWorkflow } from '../../src/dbos/workflows/run-execution-workflow.js';
import type { FinishedNodeExecutionResult } from '../../src/pipeline/interpreter/pipeline-node-result.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const input = { runId: 'run-1', scopeId: `sc1_${'a'.repeat(43)}` };

const sentMessageKinds = (): readonly string[] =>
  dbos.send.mock.calls.flatMap(([, message]) =>
    message !== null &&
    typeof message === 'object' &&
    'kind' in message &&
    typeof message.kind === 'string'
      ? [message.kind]
      : [],
  );

const executeWorkflow = async (executionResult: FinishedNodeExecutionResult) => {
  const coordinator = new RunCoordinatorClient(input.runId);
  const interpreter = {
    execute: vi.fn<() => Promise<FinishedNodeExecutionResult>>(async () => executionResult),
  };
  const cancellation = new ScopeCancellationRegistry();
  const release = vi.spyOn(cancellation, 'release');
  createPipelineExecution.mockReturnValue({ coordinator, interpreter });

  const workflow = createRunExecutionWorkflow(
    new RunExecutorProvider(),
    new MapItemWorkflowProvider(),
    new ParallelBranchWorkflowProvider(),
    new RepeatIterationWorkflowProvider(),
    cancellation,
    new ProviderCallRegistry(),
  );
  const result = await workflow(input);

  return { release, result };
};

describe('run execution workflow completion provenance', () => {
  beforeEach(() => {
    createPipelineExecution.mockReset();
    loadRunWorkflowInput.mockReset().mockResolvedValue({
      executionPlan: terminalExecutionPlan(),
      input: null,
    });
    dbos.getWorkflowStatus.mockReset();
    dbos.send.mockReset().mockResolvedValue(undefined);
    dbos.recv.mockReset().mockImplementation(async (topic) => {
      if (topic === scopeReplyTopic) {
        return { kind: 'continue' };
      }
      if (topic === scopeSettlementTopic) {
        return { kind: 'settled' };
      }
      if (topic === scopeDirectiveTopic) {
        return null;
      }
      throw new Error(`Unexpected receive topic ${topic}.`);
    });
  });

  it.each([
    { status: 'succeeded', outcome: 'done' },
    { status: 'failed', outcome: 'rejected' },
    { status: 'cancelled', outcome: 'declined' },
  ] as const)('finishes and settles an authored $status End', async (result) => {
    const execution = await executeWorkflow({
      kind: 'finished',
      provenance: 'authoredEnd',
      result,
    });

    expect(execution.result).toEqual(result);
    expect(sentMessageKinds().filter((kind) => kind === 'scopeFinish')).toHaveLength(1);
    expect(sentMessageKinds().filter((kind) => kind === 'scopeSettled')).toHaveLength(1);
    expect(execution.release).toHaveBeenCalledWith(input.runId, input.scopeId);
  });

  it('settles propagated terminal cancellation without finishing', async () => {
    const result = { status: 'cancelled', outcome: 'cancelled' } as const;
    const execution = await executeWorkflow({
      kind: 'finished',
      provenance: 'terminal',
      result,
    });

    expect(execution.result).toEqual(result);
    expect(sentMessageKinds()).not.toContain('scopeFinish');
    expect(sentMessageKinds().filter((kind) => kind === 'scopeSettled')).toHaveLength(1);
    expect(execution.release).toHaveBeenCalledWith(input.runId, input.scopeId);
  });

  it('keeps terminal event-budget failure on the finish path', async () => {
    const replies = [{ kind: 'continue' }, { kind: 'fail' }];
    dbos.recv.mockImplementation(async (topic) => {
      if (topic === scopeReplyTopic) {
        return replies.shift();
      }
      if (topic === scopeSettlementTopic) {
        return { kind: 'settled' };
      }
      if (topic === scopeDirectiveTopic) {
        return null;
      }
      throw new Error(`Unexpected receive topic ${topic}.`);
    });
    const result = { status: 'failed', outcome: 'event_budget_exceeded' } as const;
    const execution = await executeWorkflow({
      kind: 'finished',
      provenance: 'terminal',
      result,
    });

    expect(execution.result).toEqual(result);
    expect(sentMessageKinds().filter((kind) => kind === 'scopeFinish')).toHaveLength(1);
    expect(sentMessageKinds().filter((kind) => kind === 'scopeSettled')).toHaveLength(1);
    expect(execution.release).toHaveBeenCalledWith(input.runId, input.scopeId);
  });
});
