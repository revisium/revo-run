import { beforeEach, describe, expect, it, vi } from 'vitest';

const createPipelineExecution = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());
const loadRunWorkflowInput = vi.hoisted(() => vi.fn<(runId: string) => Promise<unknown>>());

vi.mock('../../src/dbos/workflows/create-pipeline-execution.js', () => ({
  createPipelineExecution,
}));
vi.mock('../../src/dbos/workflows/load-run-workflow-input.js', () => ({ loadRunWorkflowInput }));

import type { PipelineNode } from '../../src/contracts/pipeline/pipeline-node.js';
import type { MapItemWorkflowInput } from '../../src/contracts/workflow/map-item-workflow-input.js';
import { ScopeCancellationRegistry } from '../../src/dbos/coordination/scope-cancellation-registry.js';
import { ProviderCallRegistry } from '../../src/dbos/executor/provider-call-registry.js';
import { RunExecutorProvider } from '../../src/dbos/executor/run-executor-provider.js';
import { ConsensusParticipantWorkflowProvider } from '../../src/dbos/workflows/consensus-participant-workflow-provider.js';
import { MapItemWorkflowProvider } from '../../src/dbos/workflows/map-item-workflow-provider.js';
import { createMapItemWorkflow } from '../../src/dbos/workflows/map-item-workflow.js';
import { ParallelBranchWorkflowProvider } from '../../src/dbos/workflows/parallel-branch-workflow-provider.js';
import { RepeatIterationWorkflowProvider } from '../../src/dbos/workflows/repeat-iteration-workflow-provider.js';
import type { PipelineExecutionContext } from '../../src/pipeline/interpreter/interpreter-context.js';
import { terminalExecutionPlan } from '../support/execution-plan.fixture.js';

const scopeId = `sc1_${'a'.repeat(43)}`;
const parentScopeId = `sc1_${'b'.repeat(43)}`;
const workflowId = `rr:scope:${scopeId}`;
const input: MapItemWorkflowInput = {
  runId: 'run-1',
  scopeId,
  parentScopeId,
  mapNodeInstanceId: `ni1_${'c'.repeat(43)}`,
  sourceIndex: 2,
  itemKey: 'raw/key',
  item: { id: 'raw/key', payload: true },
  node: { kind: 'task', key: 'review' },
  pipelineId: 'main',
  pipelineInput: { kind: 'value', value: { kind: 'json', value: null } },
  iterationInput: { iteration: { kind: 'json', value: 3 } },
  runtimePath: 'main/repositories[raw%2Fkey]',
  parentPath: 'repositories',
  inheritedOutputs: [{ path: 'prepare', output: { result: { kind: 'json', value: true } } }],
  maximumParallelism: 2,
  parentWorkflowId: `rr:scope:${parentScopeId}`,
  disposition: 'execute',
  startFence: {
    directive: 'start',
    requestId: `request:${workflowId}`,
    admissionId: `admission:${workflowId}`,
    workflowId,
  },
};

const providers = () => ({
  executor: new RunExecutorProvider(),
  maps: new MapItemWorkflowProvider(),
  parallel: new ParallelBranchWorkflowProvider(),
  repeat: new RepeatIterationWorkflowProvider(),
  consensus: new ConsensusParticipantWorkflowProvider(),
  cancellation: new ScopeCancellationRegistry(),
  calls: new ProviderCallRegistry(),
});

describe('map item workflow', () => {
  beforeEach(() => {
    createPipelineExecution.mockReset();
    loadRunWorkflowInput.mockReset().mockResolvedValue({
      executionPlan: terminalExecutionPlan(),
      input: { run: true },
    });
  });

  it('never evaluates a settlement-only body or loads run input', async () => {
    const ready = vi.fn<() => Promise<void>>(async () => undefined);
    const finish = vi.fn<() => Promise<void>>(async () => undefined);
    const scopeSettled = vi.fn<() => Promise<void>>(async () => undefined);
    const executeMapItemScope =
      vi.fn<
        (
          node: PipelineNode,
          context: PipelineExecutionContext,
          parentPath: string,
        ) => Promise<never>
      >();
    createPipelineExecution.mockReturnValue({
      coordinator: { ready, finish, scopeSettled },
      interpreter: { executeMapItemScope },
    });
    const dependencies = providers();
    const release = vi.spyOn(dependencies.cancellation, 'release');
    const workflow = createMapItemWorkflow(
      dependencies.executor,
      dependencies.maps,
      dependencies.parallel,
      dependencies.repeat,
      dependencies.consensus,
      dependencies.cancellation,
      dependencies.calls,
    );

    await expect(workflow({ ...input, disposition: 'settlementOnly' })).resolves.toEqual({
      kind: 'settlementOnly',
      sourceIndex: 2,
      itemKey: 'raw/key',
    });
    expect(loadRunWorkflowInput).not.toHaveBeenCalled();
    expect(executeMapItemScope).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(scopeSettled).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(input.runId, input.scopeId);
  });

  it('restores inherited, iteration, and nearest raw map-item context', async () => {
    let receivedContext: PipelineExecutionContext | undefined;
    const executeMapItemScope = vi.fn<
      (
        node: PipelineNode,
        context: PipelineExecutionContext,
        parentPath: string,
      ) => Promise<{ readonly kind: 'continued'; readonly outcome: string }>
    >(async (_node: PipelineNode, context: PipelineExecutionContext, _parentPath: string) => {
      receivedContext = context;
      return { kind: 'continued' as const, outcome: 'completed' };
    });
    createPipelineExecution.mockReturnValue({
      coordinator: {
        ready: vi.fn<() => Promise<void>>(async () => undefined),
        finish: vi.fn<() => Promise<void>>(async () => undefined),
        scopeSettled: vi.fn<() => Promise<void>>(async () => undefined),
      },
      interpreter: { executeMapItemScope },
    });
    const dependencies = providers();
    const workflow = createMapItemWorkflow(
      dependencies.executor,
      dependencies.maps,
      dependencies.parallel,
      dependencies.repeat,
      dependencies.consensus,
      dependencies.cancellation,
      dependencies.calls,
    );

    await expect(workflow(input)).resolves.toEqual({
      kind: 'continued',
      sourceIndex: 2,
      itemKey: 'raw/key',
      outcome: 'completed',
    });
    expect(executeMapItemScope).toHaveBeenCalledOnce();
    expect(receivedContext).toMatchObject({
      scopeId,
      runtimePath: input.runtimePath,
      nodePathPrefix: input.parentPath,
      mapItem: input.item,
      iterationInput: input.iterationInput,
    });
    expect(receivedContext?.outputs.get('prepare')).toEqual(input.inheritedOutputs[0]?.output);
  });
});
