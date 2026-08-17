import { PipelineInterpreter } from '../../pipeline/interpreter/pipeline-interpreter.js';
import type { ExecuteNodeEffect } from '../../pipeline/interpreter/task-execution-ports.js';
import { DbosConsensusParticipantRunner } from '../consensus/dbos-consensus-participant-runner.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { ProviderCallRegistry } from '../executor/provider-call-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import { DbosMapItemRunner } from '../map/dbos-map-item-runner.js';
import { DbosParallelBranchRunner } from '../parallel/dbos-parallel-branch-runner.js';
import { DbosRepeatIterationRunner } from '../repeat/dbos-repeat-iteration-runner.js';
import { NodeExecutionStep } from '../steps/node-execution-step.js';
import type { ConsensusParticipantWorkflowProvider } from './consensus-participant-workflow-provider.js';
import type { MapItemWorkflowProvider } from './map-item-workflow-provider.js';
import type { ParallelBranchWorkflowProvider } from './parallel-branch-workflow-provider.js';
import type { RepeatIterationWorkflowProvider } from './repeat-iteration-workflow-provider.js';

interface PipelineExecutionDependencies {
  readonly executor: RunExecutorProvider;
  readonly mapItemWorkflows: MapItemWorkflowProvider;
  readonly parallelBranchWorkflows: ParallelBranchWorkflowProvider;
  readonly repeatIterationWorkflows: RepeatIterationWorkflowProvider;
  readonly consensusParticipantWorkflows: ConsensusParticipantWorkflowProvider;
  readonly cancellation: ScopeCancellationRegistry;
  readonly providerCalls: ProviderCallRegistry;
  readonly observeEffect?: (result: Awaited<ReturnType<ExecuteNodeEffect>>) => void;
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
    consensusParticipantWorkflows,
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
  const execute: ExecuteNodeEffect = async (...arguments_) => {
    const result = await execution.execute(...arguments_);
    dependencies.observeEffect?.(result);
    return result;
  };
  const interpreter = new PipelineInterpreter({
    executeEffect: execute,
    waitForRetry: (request, delayMs) => coordinator.waitForRetry(request, delayMs),
    parallel: new DbosParallelBranchRunner(parallelBranchWorkflows, coordinator),
    repeatIterations: new DbosRepeatIterationRunner(repeatIterationWorkflows, coordinator),
    mapItems: new DbosMapItemRunner(mapItemWorkflows, coordinator),
    inlineScopes: coordinator,
    events: coordinator,
    waitForDelay: (durationMs) => coordinator.waitForDelay(durationMs),
    waitForUnknownOutcome: (request, recovery, retry, reconciliationRound) =>
      coordinator.waitForUnknownOutcome(request, recovery, retry, reconciliationRound),
    waitForHumanGate: (request) => coordinator.waitForHumanGate(request),
    consensus: {
      runner: new DbosConsensusParticipantRunner(consensusParticipantWorkflows, coordinator),
      wait: (request) => coordinator.waitForConsensusResolution(request),
    },
  });
  return { coordinator, interpreter };
};
