import { PipelineInterpreter } from '../../pipeline/interpreter/pipeline-interpreter.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { ProviderCallRegistry } from '../executor/provider-call-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { DbosParallelBranchRunner } from '../parallel/dbos-parallel-branch-runner.js';
import { NodeExecutionStep } from '../steps/node-execution-step.js';
import type { ParallelBranchWorkflowProvider } from './parallel-branch-workflow-provider.js';

export const createPipelineExecution = (
  runId: string,
  maximumParallelism: number,
  executor: RunExecutorProvider,
  parallelBranchWorkflows: ParallelBranchWorkflowProvider,
  cancellation: ScopeCancellationRegistry,
  providerCalls: ProviderCallRegistry,
) => {
  const coordinator = new RunCoordinatorClient(runId);
  const execution = new NodeExecutionStep(
    executor,
    cancellation,
    providerCalls,
    coordinator,
    maximumParallelism,
  );
  const interpreter = new PipelineInterpreter(
    execution.execute,
    (request, delayMs) => coordinator.waitForRetry(request, delayMs),
    new DbosParallelBranchRunner(parallelBranchWorkflows, coordinator),
    coordinator,
    (request, recovery, retry, reconciliationRound) =>
      coordinator.waitForUnknownOutcome(request, recovery, retry, reconciliationRound),
  );
  return { coordinator, interpreter };
};
