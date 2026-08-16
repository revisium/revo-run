import { childNodePath } from '../../contracts/pipeline/node-path.js';
import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import { createParallelBranchScopeId } from '../../pipeline/identity/execution-identity.js';
import { scopeWorkflowId } from '../workflow-id.js';
import { mintNodeInstanceIdentity } from './observable-gate-candidates.js';
import {
  observableDisplayPath,
  type ObservableParallelCandidate,
  type ObservableScopeCandidate,
  type ObservableTraversalContext,
} from './observable-plan-model.js';

interface ParallelBranchOperations {
  readonly addScope: (candidate: ObservableScopeCandidate) => void;
  readonly walkBody: (
    node: PipelineNode,
    parentPath: string,
    context: ObservableTraversalContext,
  ) => void;
}

/** Owns parallel-branch candidate identity and scope construction, a sibling of ObservableMapItems. */
export class ObservableParallelBranches {
  private readonly candidates = new Map<string, ObservableParallelCandidate>();

  get byDisplayPath(): ReadonlyMap<string, ObservableParallelCandidate> {
    return this.candidates;
  }

  register(
    node: Extract<PipelineNode, { readonly kind: 'parallel' }>,
    nodePath: string,
    context: ObservableTraversalContext,
    schemaVersion: number,
    operations: ParallelBranchOperations,
  ): void {
    const { authoredNodeId, id: nodeInstanceId } = mintNodeInstanceIdentity(
      schemaVersion,
      node.kind,
      nodePath,
      context,
    );
    const parallelDisplayPath = observableDisplayPath(context, nodePath);
    const branchScopeIds = new Map<string, string>();
    for (const [branchKey, branch] of Object.entries(node.branches)) {
      const id = createParallelBranchScopeId({
        parentScopeId: context.logicalScopeId,
        authoredNodeId,
        branchKey,
      });
      branchScopeIds.set(branchKey, id);
      operations.addScope({
        id,
        kind: 'parallelBranch',
        parentScopeId: context.logicalScopeId,
        pipelineId: context.pipelineId,
        displayPath: observableDisplayPath(context, childNodePath(nodePath, branchKey)),
        physicalScopeId: id,
        parentWorkflowId: scopeWorkflowId(context.physicalScopeId),
        parallelIdentity: {
          branchKey,
          node: branch,
          pipelineId: context.pipelineId,
          runtimePath: context.runtimePath,
          parentPath: nodePath,
          ...(context.nodePathPrefix === undefined || context.nodePathPrefix.length === 0
            ? {}
            : { nodePathPrefix: context.nodePathPrefix }),
        },
      });
      operations.walkBody(branch, nodePath, {
        logicalScopeId: id,
        physicalScopeId: id,
        pipelineId: context.pipelineId,
        runtimePath: context.runtimePath,
        ...(context.nodePathPrefix === undefined ? {} : { nodePathPrefix: context.nodePathPrefix }),
      });
    }
    this.candidates.set(parallelDisplayPath, {
      node,
      nodeInstanceId,
      scopeId: context.logicalScopeId,
      physicalScopeId: context.physicalScopeId,
      branchScopeIds,
    });
  }
}
