import type { ParallelBranchResult } from '../../contracts/workflow/parallel-branch-result.js';
import type { ParallelBranchWorkflowInput } from '../../contracts/workflow/parallel-branch-workflow-input.js';
import type { PipelineExecutionContext } from '../../pipeline/interpreter/interpreter-context.js';
import { parseParallelBranchWorkflowInput } from '../../validation/parallel-branch-workflow-input.validator.js';
import {
  ScopeCancellationError,
  ScopeFailureFenceError,
} from '../coordination/run-coordinator-client.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { ProviderCallRegistry } from '../executor/provider-call-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { createPipelineExecution } from './create-pipeline-execution.js';
import { loadRunWorkflowInput } from './load-run-workflow-input.js';
import type { ParallelBranchWorkflowProvider } from './parallel-branch-workflow-provider.js';

export type ParallelBranchWorkflow = (
  input: ParallelBranchWorkflowInput,
) => Promise<ParallelBranchResult>;

export const createParallelBranchWorkflow = (
  executor: RunExecutorProvider,
  workflows: ParallelBranchWorkflowProvider,
  cancellation: ScopeCancellationRegistry,
  providerCalls: ProviderCallRegistry,
): ParallelBranchWorkflow =>
  async function parallelBranch(durableInput) {
    const input = parseParallelBranchWorkflowInput(durableInput);
    const { coordinator, interpreter } = createPipelineExecution(
      input.runId,
      input.maximumParallelism,
      executor,
      workflows,
      cancellation,
      providerCalls,
    );
    try {
      await coordinator.ready(input.parentWorkflowId, input.startFence);
      if (input.disposition === 'settlementOnly') {
        await coordinator.finish();
        return { status: 'cancelled', key: input.branchKey };
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
      };
      const result = await interpreter.executeBranchScope(
        input.node,
        context,
        input.parentPath,
        input.branchKey,
        new Set(input.inheritedOutputs.map(({ path }) => path)),
      );
      await coordinator.finish();
      return { status: 'completed', ...result };
    } catch (error) {
      if (error instanceof ScopeCancellationError || error instanceof ScopeFailureFenceError) {
        return { status: 'cancelled', key: input.branchKey };
      }
      throw error;
    } finally {
      cancellation.release(input.runId, input.scopeId);
      await coordinator.scopeSettled();
    }
  };
