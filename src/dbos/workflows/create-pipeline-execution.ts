import { PipelineInterpreter } from '../../pipeline/interpreter/pipeline-interpreter.js';
import { rejectUnsupportedUnknownOutcomeResolution } from '../../pipeline/interpreter/unsupported-unknown-outcome-resolution.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { DbosParallelBranchRunner } from '../parallel/dbos-parallel-branch-runner.js';
import { NodeExecutionStep } from '../steps/node-execution-step.js';
import { waitForDurableRetryV1 } from '../wait/dbos-retry-wait.js';
import type { ParallelBranchWorkflowProvider } from './parallel-branch-workflow-provider.js';

export interface PipelineExecution {
  readonly coordinator: RunCoordinatorClient;
  readonly interpreter: PipelineInterpreter;
}

export const createPipelineExecution = (
  runId: string,
  executor: RunExecutorProvider,
  parallelBranchWorkflows: ParallelBranchWorkflowProvider,
): PipelineExecution => {
  const coordinator = new RunCoordinatorClient(runId);
  const interpreter = new PipelineInterpreter(
    coordinator.executionStep(new NodeExecutionStep(executor)),
    waitForDurableRetryV1,
    new DbosParallelBranchRunner(parallelBranchWorkflows, coordinator),
    coordinator,
    rejectUnsupportedUnknownOutcomeResolution,
  );

  return { coordinator, interpreter };
};
