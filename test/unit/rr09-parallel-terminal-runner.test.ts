import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParallelNode } from '../../src/contracts/pipeline/pipeline-node.js';
import type { ParallelBranchResult } from '../../src/contracts/workflow/parallel-branch-result.js';
import type { ParallelBranchWorkflowInput } from '../../src/contracts/workflow/parallel-branch-workflow-input.js';
import { RunCoordinatorClient } from '../../src/dbos/coordination/run-coordinator-client.js';
import { DbosParallelBranchRunner } from '../../src/dbos/parallel/dbos-parallel-branch-runner.js';
import { ParallelBranchWorkflowProvider } from '../../src/dbos/workflows/parallel-branch-workflow-provider.js';
import type { PipelineExecutionContext } from '../../src/pipeline/interpreter/interpreter-context.js';
import { executionPlan, task } from '../dsl/pipeline-builder.js';

const physicalWorkflowId = `rr:scope:sc1_${'a'.repeat(43)}`;
const scopeId = physicalWorkflowId.slice('rr:scope:'.length);

const parallelNode = (remaining: 'cancel' | 'drain'): ParallelNode => ({
  kind: 'parallel',
  key: 'review',
  branches: {
    winner: task('winner'),
    terminal: task('terminal'),
    third: task('third'),
    fourth: task('fourth'),
  },
  join: { kind: 'any', successfulOutcomes: ['completed'], remaining },
});

const contextFor = (node: ParallelNode): PipelineExecutionContext => ({
  plan: executionPlan(node),
  runId: 'run-1',
  scopeId,
  runInput: null,
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
  runtimePath: 'main',
  outputs: new Map(),
  maximumParallelism: 2,
});

const continued = (key: string, withOutput = false): ParallelBranchResult => ({
  kind: 'continued',
  key,
  outcome: 'completed',
  outputs: withOutput ? [[`review/${key}`, { result: { kind: 'json', value: key } }]] : [],
});

const terminalFailure: ParallelBranchResult = {
  kind: 'terminal',
  key: 'terminal',
  result: {
    status: 'failed',
    outcome: 'invalid',
    output: { diagnostic: { kind: 'json', value: 'terminal-only' } },
  },
};

const eventBudgetFailure = (key: string): ParallelBranchResult => ({
  kind: 'terminal',
  key,
  result: { status: 'failed', outcome: 'event_budget_exceeded' },
});

interface Harness {
  readonly cancelScopes: ReturnType<typeof vi.fn<RunCoordinatorClient['cancelScopes']>>;
  readonly inputs: ParallelBranchWorkflowInput[];
  readonly persistedDecisions: () => number;
  readonly runner: DbosParallelBranchRunner;
}

const harness = (
  results: Readonly<Record<string, unknown>>,
  settlementOrder: readonly string[],
): Harness => {
  const inputs: ParallelBranchWorkflowInput[] = [];
  const keyByWorkflowId = new Map<string, string>();
  const handles = new Map<
    string,
    { readonly workflowID: string; readonly getResult: () => Promise<unknown> }
  >();
  vi.spyOn(DBOS, 'startWorkflow').mockImplementation(
    (_workflow, options) => async (input: ParallelBranchWorkflowInput) => {
      if (options?.workflowID === undefined) {
        throw new Error('Expected a deterministic branch workflow ID.');
      }
      const result =
        results[input.branchKey] ??
        (input.disposition === 'settlementOnly'
          ? ({
              kind: 'terminal',
              key: input.branchKey,
              result: { status: 'cancelled', outcome: 'cancelled' },
            } as const)
          : undefined);
      if (result === undefined) {
        throw new Error(`No branch result for ${input.branchKey}.`);
      }
      inputs.push(input);
      keyByWorkflowId.set(options.workflowID, input.branchKey);
      const handle = { workflowID: options.workflowID, getResult: async () => result };
      handles.set(options.workflowID, handle);
      return handle;
    },
  );
  const pendingOrder = [...settlementOrder];
  vi.spyOn(DBOS, 'waitFirst').mockImplementation(async (active) => {
    const key = pendingOrder.shift();
    const handle = active.find((candidate) => keyByWorkflowId.get(candidate.workflowID) === key);
    if (handle === undefined) {
      throw new Error(`Settlement ${String(key)} is not active.`);
    }
    return handle;
  });
  const runStep = vi.spyOn(DBOS, 'runStep').mockImplementation(async (callback) => callback());
  vi.spyOn(DBOS, 'workflowID', 'get').mockReturnValue(physicalWorkflowId);

  const cancelScopes = vi.fn<RunCoordinatorClient['cancelScopes']>(async () => undefined);
  const coordinator = new RunCoordinatorClient('run-1');
  coordinator.admitScope = async (workflowId: string) => ({
    directive: 'start' as const,
    requestId: `request:${workflowId}`,
    admissionId: `admission:${workflowId}`,
    workflowId,
  });
  coordinator.cancelScopes = cancelScopes;
  const workflows = new ParallelBranchWorkflowProvider();
  workflows.register(async () => Promise.reject(new Error('Workflow should be mocked.')));
  return {
    cancelScopes,
    inputs,
    persistedDecisions: () => runStep.mock.calls.length,
    runner: new DbosParallelBranchRunner(workflows, coordinator),
  };
};

describe('RR-09 parallel terminal settlement', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('lets an active terminal override an early drain decision without leaking output', async () => {
    const node = parallelNode('drain');
    const subject = harness({ winner: continued('winner', true), terminal: terminalFailure }, [
      'winner',
      'terminal',
      'third',
    ]);

    const result = await subject.runner.execute(node, contextFor(node), 'review');

    expect(result).toEqual({ kind: 'terminal', result: terminalFailure.result });
    expect('eligibleResults' in result).toBe(false);
    expect(subject.inputs.map(({ branchKey, disposition }) => [branchKey, disposition])).toEqual([
      ['winner', 'execute'],
      ['terminal', 'execute'],
      ['third', 'settlementOnly'],
    ]);
    expect(subject.cancelScopes).not.toHaveBeenCalled();
  });

  it('does not let a deliberately cancelled loser override a valid cancel join', async () => {
    const node = parallelNode('cancel');
    const subject = harness(
      {
        winner: continued('winner', true),
        terminal: {
          kind: 'terminal',
          key: 'terminal',
          result: { status: 'cancelled', outcome: 'cancelled' },
        },
      },
      ['winner', 'terminal'],
    );

    const result = await subject.runner.execute(node, contextFor(node), 'review');

    expect(result).toMatchObject({
      kind: 'continued',
      outcome: 'completed',
      eligibleResults: [{ key: 'winner' }],
    });
    expect(subject.cancelScopes).toHaveBeenCalledOnce();
    expect(subject.inputs.map(({ branchKey }) => branchKey)).toEqual(['winner', 'terminal']);
  });

  it('keeps event-budget failure authoritative after a cancel join decision', async () => {
    const node = parallelNode('cancel');
    const subject = harness(
      { winner: continued('winner'), terminal: eventBudgetFailure('terminal') },
      ['winner', 'terminal'],
    );

    await expect(subject.runner.execute(node, contextFor(node), 'review')).resolves.toEqual({
      kind: 'terminal',
      result: { status: 'failed', outcome: 'event_budget_exceeded' },
    });
  });

  it.each([
    [
      'obsolete completed result',
      { status: 'completed', key: 'winner', outcome: 'completed', outputs: [] },
    ],
    [
      'terminal success',
      {
        kind: 'terminal',
        key: 'winner',
        result: { status: 'succeeded', outcome: 'completed' },
      },
    ],
    [
      'cancelled terminal output',
      {
        kind: 'terminal',
        key: 'winner',
        result: { status: 'cancelled', outcome: 'cancelled', output: {} },
      },
    ],
    [
      'terminal extra property',
      {
        kind: 'terminal',
        key: 'winner',
        result: { status: 'failed', outcome: 'invalid' },
        runtimePath: 'must-not-leak',
      },
    ],
    [
      'malformed terminal output',
      {
        kind: 'terminal',
        key: 'winner',
        result: {
          status: 'failed',
          outcome: 'invalid',
          output: { result: { kind: 'json' } },
        },
      },
    ],
  ])('rejects a live %s before join reduction', async (_name, durableResult) => {
    const node = parallelNode('drain');
    const subject = harness({ winner: durableResult, terminal: continued('terminal') }, ['winner']);

    await expect(subject.runner.execute(node, contextFor(node), 'review')).rejects.toThrow(
      'Parallel branch workflow result is invalid.',
    );
    expect(subject.persistedDecisions()).toBe(0);
  });

  it('keeps the first terminal authoritative while its cancelled sibling is discarded', async () => {
    const node = parallelNode('cancel');
    const subject = harness(
      {
        winner: { kind: 'terminal', key: 'winner', result: terminalFailure.result },
        terminal: {
          kind: 'terminal',
          key: 'terminal',
          result: { status: 'cancelled', outcome: 'cancelled' },
        },
      },
      ['winner', 'terminal'],
    );

    await expect(subject.runner.execute(node, contextFor(node), 'review')).resolves.toEqual({
      kind: 'terminal',
      result: terminalFailure.result,
    });
    expect(subject.cancelScopes).toHaveBeenCalledOnce();
    expect(subject.inputs.map(({ branchKey }) => branchKey)).toEqual(['winner', 'terminal']);
  });
});
