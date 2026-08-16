import { childNodePath } from '../../contracts/pipeline/node-path.js';
import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import { createConsensusParticipantScopeId } from '../../pipeline/identity/execution-identity.js';
import { scopeWorkflowId } from '../workflow-id.js';
import { mintNodeInstanceIdentity } from './observable-gate-candidates.js';
import {
  observableDisplayPath,
  type ObservableScopeCandidate,
  type ObservableTraversalContext,
} from './observable-plan-model.js';

export interface ObservableConsensusCandidate {
  readonly node: Extract<PipelineNode, { readonly kind: 'consensus' }>;
  readonly nodeInstanceId: string;
  readonly authoredNodeId: string;
  readonly scopeId: string;
  readonly physicalScopeId: string;
  readonly pipelineId: string;
  readonly nodePath: string;
  readonly displayPath: string;
  readonly participantIds: readonly string[];
  readonly participantScopeIds: ReadonlyMap<string, string>;
}

interface ConsensusParticipantOperations {
  readonly addScope: (candidate: ObservableScopeCandidate) => void;
  readonly walkBody: (
    node: PipelineNode,
    parentPath: string,
    context: ObservableTraversalContext,
  ) => void;
}

export class ObservableConsensusParticipants {
  private readonly candidates = new Map<string, ObservableConsensusCandidate>();

  get byNodeInstanceId(): ReadonlyMap<string, ObservableConsensusCandidate> {
    return this.candidates;
  }

  register(
    node: Extract<PipelineNode, { readonly kind: 'consensus' }>,
    nodePath: string,
    context: ObservableTraversalContext,
    schemaVersion: number,
    operations: ConsensusParticipantOperations,
  ): void {
    const { authoredNodeId, id: nodeInstanceId } = mintNodeInstanceIdentity(
      schemaVersion,
      node.kind,
      nodePath,
      context,
    );
    const participantScopeIds = new Map<string, string>();
    for (const [participantId, task] of Object.entries(node.participants)) {
      const id = createConsensusParticipantScopeId({
        parentScopeId: context.logicalScopeId,
        authoredNodeId,
        participantId,
      });
      participantScopeIds.set(participantId, id);
      operations.addScope({
        id,
        kind: 'consensusParticipant',
        parentScopeId: context.logicalScopeId,
        pipelineId: context.pipelineId,
        displayPath: observableDisplayPath(context, childNodePath(nodePath, participantId)),
        physicalScopeId: id,
        parentWorkflowId: scopeWorkflowId(context.physicalScopeId),
        consensusIdentity: {
          participantId,
          consensusNodeInstanceId: nodeInstanceId,
          node: task,
          pipelineId: context.pipelineId,
          runtimePath: context.runtimePath,
          parentPath: nodePath,
          ...(context.nodePathPrefix === undefined || context.nodePathPrefix.length === 0
            ? {}
            : { nodePathPrefix: context.nodePathPrefix }),
        },
      });
      operations.walkBody(task, nodePath, {
        logicalScopeId: id,
        physicalScopeId: id,
        pipelineId: context.pipelineId,
        runtimePath: context.runtimePath,
        ...(context.nodePathPrefix === undefined ? {} : { nodePathPrefix: context.nodePathPrefix }),
      });
    }
    this.candidates.set(nodeInstanceId, {
      node,
      nodeInstanceId,
      authoredNodeId,
      scopeId: context.logicalScopeId,
      physicalScopeId: context.physicalScopeId,
      pipelineId: context.pipelineId,
      nodePath,
      displayPath: observableDisplayPath(context, nodePath),
      participantIds: Object.keys(node.participants),
      participantScopeIds,
    });
  }
}
