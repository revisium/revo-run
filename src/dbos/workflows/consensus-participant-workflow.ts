import type { ConsensusParticipantWorkflowInput } from '../../contracts/workflow/consensus-participant-workflow-input.js';
import type { ParticipantSettlement } from '../../contracts/workflow/participant-settlement.js';
import {
  classifyNodeExecutionSettlement,
  type ParticipantEffectProvenance,
} from '../../pipeline/consensus/classify-participant-settlement.js';
import type {
  ExecuteNodeEffect,
  PipelineExecutionContext,
} from '../../pipeline/interpreter/interpreter-context.js';
import { parseConsensusParticipantWorkflowInput } from '../../validation/consensus-participant-workflow-input.validator.js';
import { asConsensusVote } from '../../validation/consensus-vote.validator.js';
import {
  ScopeCancellationError,
  ScopeFailureFenceError,
} from '../coordination/run-coordinator-client.js';
import type { ScopeCancellationRegistry } from '../coordination/scope-cancellation-registry.js';
import type { ProviderCallRegistry } from '../executor/provider-call-registry.js';
import type { RunExecutorProvider } from '../executor/run-executor-provider.js';
import type { ConsensusParticipantWorkflowProvider } from './consensus-participant-workflow-provider.js';
import { createPipelineExecution } from './create-pipeline-execution.js';
import { loadRunWorkflowInput } from './load-run-workflow-input.js';
import type { MapItemWorkflowProvider } from './map-item-workflow-provider.js';
import type { ParallelBranchWorkflowProvider } from './parallel-branch-workflow-provider.js';
import type { RepeatIterationWorkflowProvider } from './repeat-iteration-workflow-provider.js';

export type ConsensusParticipantWorkflow = (
  input: ConsensusParticipantWorkflowInput,
) => Promise<ParticipantSettlement>;

export const createConsensusParticipantWorkflow = (
  executor: RunExecutorProvider,
  mapWorkflows: MapItemWorkflowProvider,
  parallelWorkflows: ParallelBranchWorkflowProvider,
  repeatWorkflows: RepeatIterationWorkflowProvider,
  consensusWorkflows: ConsensusParticipantWorkflowProvider,
  cancellation: ScopeCancellationRegistry,
  providerCalls: ProviderCallRegistry,
): ConsensusParticipantWorkflow =>
  async function consensusParticipant(durableInput) {
    const input = parseConsensusParticipantWorkflowInput(durableInput);
    let lastEffect: Awaited<ReturnType<ExecuteNodeEffect>> | undefined;
    const { coordinator, interpreter } = createPipelineExecution(
      input.runId,
      input.maximumParallelism,
      {
        executor,
        mapItemWorkflows: mapWorkflows,
        parallelBranchWorkflows: parallelWorkflows,
        repeatIterationWorkflows: repeatWorkflows,
        consensusParticipantWorkflows: consensusWorkflows,
        cancellation,
        providerCalls,
        observeEffect: (result) => {
          lastEffect = result;
        },
      },
    );
    try {
      await coordinator.ready(input.parentWorkflowId, input.startFence);
      if (input.node.kind !== 'task') {
        throw new Error('Consensus participant node must be a task.');
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
        ...(input.nodePathPrefix === undefined ? {} : { nodePathPrefix: input.nodePathPrefix }),
        ...(input.iterationInput === undefined ? {} : { iterationInput: input.iterationInput }),
        ...(input.mapItem === undefined ? {} : { mapItem: input.mapItem }),
      };
      const result = await interpreter.executeConsensusParticipantScope(
        input.node,
        context,
        input.parentPath,
      );
      const outputVote = result.kind === 'continued' ? result.output?.vote : undefined;
      const vote = outputVote?.kind === 'json' ? asConsensusVote(outputVote.value) : undefined;
      const settlement = classifyNodeExecutionSettlement(
        input.participantId,
        result,
        vote,
        effectProvenance(lastEffect),
      );
      await coordinator.reportConsensusSettlement(
        input.parentWorkflowId,
        input.consensusNodeInstanceId,
        input.participantId,
        settlement,
      );
      await coordinator.finish();
      return settlement;
    } catch (error) {
      if (error instanceof ScopeCancellationError) {
        const cancelled = { kind: 'cancelled' as const };
        await coordinator.reportConsensusSettlement(
          input.parentWorkflowId,
          input.consensusNodeInstanceId,
          input.participantId,
          cancelled,
        );
        return cancelled;
      }
      if (error instanceof ScopeFailureFenceError) {
        const failed = { kind: 'executionFailed' as const };
        await coordinator.reportConsensusSettlement(
          input.parentWorkflowId,
          input.consensusNodeInstanceId,
          input.participantId,
          failed,
        );
        return failed;
      }
      const failed = { kind: 'executionFailed' as const };
      await coordinator.reportConsensusSettlement(
        input.parentWorkflowId,
        input.consensusNodeInstanceId,
        input.participantId,
        failed,
      );
      throw error;
    } finally {
      cancellation.release(input.runId, input.scopeId);
      await coordinator.scopeSettled();
    }
  };

const effectProvenance = (
  effect: Awaited<ReturnType<ExecuteNodeEffect>> | undefined,
): ParticipantEffectProvenance | undefined => {
  if (effect === undefined) {
    return undefined;
  }
  if (effect.kind === 'cancelled') {
    return 'cancelled';
  }
  if (effect.kind === 'timedOut') {
    return 'timedOut';
  }
  if (effect.kind === 'effectResult' && effect.execution.result.kind === 'completed') {
    return 'completed';
  }
  if (
    effect.kind === 'effectResult' ||
    effect.kind === 'outcomeUnknown' ||
    effect.kind === 'recoveryExhausted'
  ) {
    return 'failed';
  }
  return undefined;
};
