import type { RepeatIterationResult } from '../../contracts/workflow/repeat-iteration-result.js';
import type { RepeatIterationWorkflowInput } from '../../contracts/workflow/repeat-iteration-workflow-input.js';
import type { PipelineExecutionContext } from '../../pipeline/interpreter/interpreter-context.js';
import { parseRepeatIterationWorkflowInput } from '../../validation/repeat-iteration-workflow-input.validator.js';
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

export type RepeatIterationWorkflow = (
  input: RepeatIterationWorkflowInput,
) => Promise<RepeatIterationResult>;

export const createRepeatIterationWorkflow = (
  executor: RunExecutorProvider,
  mapWorkflows: MapItemWorkflowProvider,
  parallelWorkflows: ParallelBranchWorkflowProvider,
  repeatWorkflows: RepeatIterationWorkflowProvider,
  cancellation: ScopeCancellationRegistry,
  providerCalls: ProviderCallRegistry,
): RepeatIterationWorkflow =>
  async function repeatIteration(durableInput) {
    const input = parseRepeatIterationWorkflowInput(durableInput);
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
        iterationInput: input.iterationInput,
        ...(input.mapItem === undefined ? {} : { mapItem: input.mapItem }),
      };
      const result = await interpreter.executeRepeatIterationScope(
        input.node,
        context,
        input.parentPath,
      );
      await coordinator.finish();
      return result.kind === 'continued'
        ? {
            kind: 'continued',
            ordinal: input.ordinal,
            outcome: result.outcome,
            ...(result.output === undefined ? {} : { output: result.output }),
          }
        : { kind: 'terminal', ordinal: input.ordinal, result: result.result };
    } catch (error) {
      if (error instanceof ScopeCancellationError) {
        return {
          kind: 'terminal',
          ordinal: input.ordinal,
          result: { status: 'cancelled', outcome: 'cancelled' },
        };
      }
      if (error instanceof ScopeFailureFenceError) {
        return {
          kind: 'terminal',
          ordinal: input.ordinal,
          result: { status: 'failed', outcome: 'event_budget_exceeded' },
        };
      }
      throw error;
    } finally {
      cancellation.release(input.runId, input.scopeId);
      await coordinator.scopeSettled();
    }
  };
