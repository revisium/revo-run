import { PipelineInterpreter } from '../../pipeline/interpreter/pipeline-interpreter.js';
import { RunCoordinatorV2Client } from '../coordination/run-coordinator-v2-client.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { DbosParallelBranchRunnerV2 } from '../parallel/dbos-parallel-branch-runner-v2.js';
import { NodeExecutionStepV2 } from '../steps/node-execution-step-v2.js';
import type { ParallelBranchWorkflowV2Provider } from './parallel-branch-workflow-v2-provider.js';

export const createPipelineExecutionV2 = (
  runId: string,
  executor: RunExecutorProvider,
  parallelBranchWorkflows: ParallelBranchWorkflowV2Provider,
  cancellation: ScopeCancellationRegistry,
) => {
  const coordinator = new RunCoordinatorV2Client(runId);
  const interpreter = new PipelineInterpreter(
    coordinator.executionStep(new NodeExecutionStepV2(executor, cancellation)),
    (request, delayMs) => coordinator.waitForRetry(request, delayMs),
    new DbosParallelBranchRunnerV2(parallelBranchWorkflows, coordinator),
    coordinator,
    (request, recovery, retry, reconciliationRound) =>
      coordinator.waitForUnknownOutcome(request, recovery, retry, reconciliationRound),
  );
  return { coordinator, interpreter };
};
