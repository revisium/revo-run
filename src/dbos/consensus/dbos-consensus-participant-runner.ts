import { DBOS, type WorkflowHandle } from '@dbos-inc/dbos-sdk';

import { childNodePath } from '../../contracts/pipeline/node-path.js';
import type { ConsensusNode, TaskNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ConsensusParticipantWorkflowInput } from '../../contracts/workflow/consensus-participant-workflow-input.js';
import type { ConsensusResolutionDirective } from '../../contracts/workflow/consensus-resolution.js';
import type { ParticipantSettlement } from '../../contracts/workflow/participant-settlement.js';
import {
  createAuthoredNodeId,
  createConsensusParticipantScopeId,
  createNodeInstanceId,
} from '../../pipeline/identity/execution-identity.js';
import type {
  ConsensusParticipantInstance,
  ConsensusParticipantRunner,
  ConsensusWaitRequest,
  PipelineExecutionContext,
  WaitForConsensusResolution,
} from '../../pipeline/interpreter/interpreter-context.js';
import { parseParticipantSettlement } from '../../validation/participant-settlement.validator.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import { scopeWorkflowId } from '../workflow-id.js';
import type { ConsensusParticipantWorkflowProvider } from '../workflows/consensus-participant-workflow-provider.js';

interface ActiveParticipant {
  readonly instance: ConsensusParticipantInstance;
  readonly handle: WorkflowHandle<ParticipantSettlement>;
}

export class DbosConsensusParticipantRunner implements ConsensusParticipantRunner {
  constructor(
    private readonly workflows: ConsensusParticipantWorkflowProvider,
    private readonly coordinator: RunCoordinatorClient,
  ) {}

  async execute(
    node: ConsensusNode,
    context: PipelineExecutionContext,
    nodePath: string,
    wait: WaitForConsensusResolution,
  ): Promise<ConsensusResolutionDirective> {
    const request = this.waitingRequest(node, context, nodePath);
    await this.coordinator.registerConsensusWaiting(request);
    const active = await this.startParticipants(node, context, nodePath, request);
    const resolution = await wait(request);
    if (resolution.kind === 'decided' && resolution.verdict.remaining === 'cancel') {
      const remaining = new Set(resolution.verdict.remainingParticipantIds);
      const workflowIds = [...active.values()]
        .filter(({ instance }) => remaining.has(instance.participantId))
        .map(({ instance }) => instance.workflowId);
      await this.coordinator.cancelScopes(workflowIds, request.consensusNodeInstanceId);
    }
    await this.awaitRemaining(active);
    return resolution;
  }

  private waitingRequest(
    node: ConsensusNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): ConsensusWaitRequest {
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: context.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: 'consensus',
    });
    const consensusNodeInstanceId = createNodeInstanceId({
      scopeId: context.scopeId,
      authoredNodeId,
    });
    const participantIds = Object.keys(node.participants);
    const participantInstances = participantIds.map((participantId) =>
      this.participantInstance(
        context,
        nodePath,
        authoredNodeId,
        consensusNodeInstanceId,
        participantId,
      ),
    );
    return {
      consensusNodeInstanceId,
      scopeId: context.scopeId,
      authoredNodeId,
      pipelineId: context.pipelineId,
      nodePath,
      participantIds,
      participantInstances,
      policy: node.policy,
      remaining: node.remaining,
      ...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs }),
    };
  }

  private participantInstance(
    context: PipelineExecutionContext,
    consensusNodePath: string,
    consensusAuthoredNodeId: string,
    consensusNodeInstanceId: string,
    participantId: string,
  ): ConsensusParticipantInstance {
    const scopeId = createConsensusParticipantScopeId({
      parentScopeId: context.scopeId,
      authoredNodeId: consensusAuthoredNodeId,
      participantId,
    });
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: context.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath: childNodePath(consensusNodePath, participantId),
      nodeKind: 'task',
    });
    return {
      participantId,
      scopeId,
      authoredNodeId,
      nodeInstanceId: createNodeInstanceId({ scopeId, authoredNodeId }),
      workflowId: scopeWorkflowId(scopeId),
    };
  }

  private startParticipants(
    node: ConsensusNode,
    context: PipelineExecutionContext,
    nodePath: string,
    request: ConsensusWaitRequest,
  ): Promise<Map<string, ActiveParticipant>> {
    return request.participantIds.reduce<Promise<Map<string, ActiveParticipant>>>(
      async (previous, participantId) => {
        const active = await previous;
        const task = node.participants[participantId];
        if (task === undefined) {
          throw new Error(`Consensus participant ${participantId} is missing.`);
        }
        const instance = request.participantInstances.find(
          (candidate) => candidate.participantId === participantId,
        );
        if (instance === undefined) {
          throw new Error(`Consensus participant identity ${participantId} is missing.`);
        }
        const handle = await this.startOne(task, context, nodePath, request, instance);
        active.set(instance.workflowId, { instance, handle });
        return active;
      },
      Promise.resolve(new Map<string, ActiveParticipant>()),
    );
  }

  private async startOne(
    node: TaskNode,
    context: PipelineExecutionContext,
    nodePath: string,
    request: ConsensusWaitRequest,
    instance: ConsensusParticipantInstance,
  ): Promise<WorkflowHandle<ParticipantSettlement>> {
    const parentWorkflowId = DBOS.workflowID;
    if (!parentWorkflowId?.startsWith('rr:scope:')) {
      throw new Error('Consensus parent has no workflow ID.');
    }
    const startFence = await this.coordinator.admitScope(instance.workflowId);
    const input: ConsensusParticipantWorkflowInput = {
      runId: context.runId,
      scopeId: instance.scopeId,
      parentScopeId: context.scopeId,
      participantId: instance.participantId,
      consensusNodeInstanceId: request.consensusNodeInstanceId,
      node,
      pipelineId: context.pipelineId,
      pipelineInput: context.pipelineInput,
      runtimePath: context.runtimePath,
      parentPath: nodePath,
      ...(context.nodePathPrefix === undefined || context.nodePathPrefix.length === 0
        ? {}
        : { nodePathPrefix: context.nodePathPrefix }),
      ...(context.iterationInput === undefined ? {} : { iterationInput: context.iterationInput }),
      ...(context.mapItem === undefined ? {} : { mapItem: context.mapItem }),
      inheritedOutputs: [...context.outputs].map(([path, output]) => ({ path, output })),
      maximumParallelism: context.maximumParallelism,
      parentWorkflowId,
      startFence,
    };
    const handle = await DBOS.startWorkflow(this.workflows.get(), {
      workflowID: instance.workflowId,
    })(input);
    if (handle.workflowID !== instance.workflowId) {
      throw new Error('Consensus participant started with an unexpected workflow ID.');
    }
    return handle;
  }

  private async awaitRemaining(active: Map<string, ActiveParticipant>): Promise<void> {
    if (active.size === 0) {
      return;
    }
    const handle = await DBOS.waitFirst([...active.values()].map(({ handle: child }) => child));
    const participant = active.get(handle.workflowID);
    if (participant === undefined) {
      throw new Error('DBOS completed an unknown consensus participant workflow.');
    }
    parseParticipantSettlement(await participant.handle.getResult());
    active.delete(handle.workflowID);
    await this.awaitRemaining(active);
  }
}
