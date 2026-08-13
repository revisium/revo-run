import type { ParallelBranchV2Result } from '../../contracts/workflow/parallel-branch-v2-result.js';
import type { ParallelBranchWorkflowV2Input } from '../../contracts/workflow/parallel-branch-workflow-v2-input.js';
import type { PipelineExecutionContext } from '../../pipeline/interpreter/interpreter-context.js';
import { parseParallelBranchWorkflowV2Input } from '../../validation/parallel-branch-workflow-v2-input.validator.js';
import {
  ScopeCancellationError,
  ScopeFailureFenceError,
} from '../coordination/run-coordinator-v2-client.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { createPipelineExecutionV2 } from './create-pipeline-execution-v2.js';
import { loadRunWorkflowInput } from './load-run-workflow-input.js';
import type { ParallelBranchWorkflowV2Provider } from './parallel-branch-workflow-v2-provider.js';

export type ParallelBranchWorkflowV2 = (
  input: ParallelBranchWorkflowV2Input,
) => Promise<ParallelBranchV2Result>;

export const createParallelBranchWorkflowV2 =
  (
    executor: RunExecutorProvider,
    workflows: ParallelBranchWorkflowV2Provider,
    cancellation: ScopeCancellationRegistry,
  ): ParallelBranchWorkflowV2 =>
  async (durableInput) => {
    const input = parseParallelBranchWorkflowV2Input(durableInput);
    const { coordinator, interpreter } = createPipelineExecutionV2(
      input.runId,
      executor,
      workflows,
      cancellation,
    );
    try {
      await coordinator.ready(input.parentWorkflowId);
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
      if (error instanceof ScopeCancellationError) {
        return { status: 'cancelled', key: input.branchKey };
      }
      if (error instanceof ScopeFailureFenceError) {
        return { status: 'cancelled', key: input.branchKey };
      }
      throw error;
    } finally {
      cancellation.release(input.runId, input.scopeId);
      await coordinator.scopeSettled();
    }
  };
