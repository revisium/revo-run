import type { MapItemResult } from '../../contracts/workflow/map-item-result.js';
import type { MapItemWorkflowInput } from '../../contracts/workflow/map-item-workflow-input.js';
import type { PipelineExecutionContext } from '../../pipeline/interpreter/interpreter-context.js';
import { parseMapItemWorkflowInput } from '../../validation/map-item-workflow-input.validator.js';
import {
  ScopeCancellationError,
  ScopeFailureFenceError,
} from '../coordination/run-coordinator-client.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { ProviderCallRegistry } from '../executor/provider-call-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { createPipelineExecution } from './create-pipeline-execution.js';
import { loadRunWorkflowInput } from './load-run-workflow-input.js';
import type { MapItemWorkflowProvider } from './map-item-workflow-provider.js';
import type { ParallelBranchWorkflowProvider } from './parallel-branch-workflow-provider.js';
import type { RepeatIterationWorkflowProvider } from './repeat-iteration-workflow-provider.js';

export type MapItemWorkflow = (input: MapItemWorkflowInput) => Promise<MapItemResult>;

export const createMapItemWorkflow = (
  executor: RunExecutorProvider,
  mapWorkflows: MapItemWorkflowProvider,
  parallelWorkflows: ParallelBranchWorkflowProvider,
  repeatWorkflows: RepeatIterationWorkflowProvider,
  cancellation: ScopeCancellationRegistry,
  providerCalls: ProviderCallRegistry,
): MapItemWorkflow =>
  async function mapItem(durableInput) {
    const input = parseMapItemWorkflowInput(durableInput);
    const { coordinator, interpreter } = createPipelineExecution(
      input.runId,
      input.maximumParallelism,
      {
        executor,
        mapItemWorkflows: mapWorkflows,
        parallelBranchWorkflows: parallelWorkflows,
        repeatIterationWorkflows: repeatWorkflows,
        cancellation,
        providerCalls,
      },
    );
    try {
      await coordinator.ready(input.parentWorkflowId, input.startFence);
      if (input.disposition === 'settlementOnly') {
        await coordinator.finish();
        return {
          kind: 'settlementOnly',
          sourceIndex: input.sourceIndex,
          itemKey: input.itemKey,
        };
      }
      const root = await loadRunWorkflowInput(input.runId);
      const context: PipelineExecutionContext = {
        plan: root.executionPlan,
        runId: input.runId,
        scopeId: input.scopeId,
        runInput: root.input,
        pipelineId: input.pipelineId,
        pipelineInput: input.pipelineInput,
        runtimePath: input.runtimePath,
        outputs: new Map(input.inheritedOutputs.map(({ path, output }) => [path, output])),
        maximumParallelism: input.maximumParallelism,
        nodePathPrefix: input.parentPath,
        mapItem: input.item,
        ...(input.iterationInput === undefined ? {} : { iterationInput: input.iterationInput }),
      };
      const result = await interpreter.executeMapItemScope(input.node, context, input.parentPath);
      await coordinator.finish();
      return { ...result, sourceIndex: input.sourceIndex, itemKey: input.itemKey };
    } catch (error) {
      if (error instanceof ScopeCancellationError) {
        return {
          kind: 'terminal',
          sourceIndex: input.sourceIndex,
          itemKey: input.itemKey,
          result: { status: 'cancelled', outcome: 'cancelled' },
        };
      }
      if (error instanceof ScopeFailureFenceError) {
        return {
          kind: 'terminal',
          sourceIndex: input.sourceIndex,
          itemKey: input.itemKey,
          result: { status: 'failed', outcome: 'event_budget_exceeded' },
        };
      }
      throw error;
    } finally {
      cancellation.release(input.runId, input.scopeId);
      await coordinator.scopeSettled();
    }
  };
