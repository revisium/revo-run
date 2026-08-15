import { PipelineInterpreter } from '../../pipeline/interpreter/pipeline-interpreter.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { ProviderCallRegistry } from '../executor/provider-call-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { DbosMapItemRunner } from '../map/dbos-map-item-runner.js';
import { DbosParallelBranchRunner } from '../parallel/dbos-parallel-branch-runner.js';
import { DbosRepeatIterationRunner } from '../repeat/dbos-repeat-iteration-runner.js';
import { NodeExecutionStep } from '../steps/node-execution-step.js';
import type { MapItemWorkflowProvider } from './map-item-workflow-provider.js';
import type { ParallelBranchWorkflowProvider } from './parallel-branch-workflow-provider.js';
import type { RepeatIterationWorkflowProvider } from './repeat-iteration-workflow-provider.js';

interface PipelineExecutionDependencies {
  readonly executor: RunExecutorProvider;
  readonly mapItemWorkflows: MapItemWorkflowProvider;
  readonly parallelBranchWorkflows: ParallelBranchWorkflowProvider;
  readonly repeatIterationWorkflows: RepeatIterationWorkflowProvider;
  readonly cancellation: ScopeCancellationRegistry;
  readonly providerCalls: ProviderCallRegistry;
}

export const createPipelineExecution = (
  runId: string,
  maximumParallelism: number,
  dependencies: PipelineExecutionDependencies,
) => {
  const {
    executor,
    mapItemWorkflows,
    parallelBranchWorkflows,
    repeatIterationWorkflows,
    cancellation,
    providerCalls,
  } = dependencies;
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
    new DbosRepeatIterationRunner(repeatIterationWorkflows, coordinator),
    new DbosMapItemRunner(mapItemWorkflows, coordinator),
    coordinator,
    coordinator,
    (durationMs) => coordinator.waitForDelay(durationMs),
    (request, recovery, retry, reconciliationRound) =>
      coordinator.waitForUnknownOutcome(request, recovery, retry, reconciliationRound),
  );
  return { coordinator, interpreter };
};
