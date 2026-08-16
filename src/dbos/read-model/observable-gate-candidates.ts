import type { HumanGateNode, PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import {
  createAuthoredNodeId,
  createNodeInstanceId,
} from '../../pipeline/identity/execution-identity.js';
import { observableDisplayPath, type ObservableTraversalContext } from './observable-plan-model.js';

export interface ObservableGateCandidate {
  readonly id: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly pipelineId: string;
  readonly nodePath: string;
  readonly displayPath: string;
  readonly physicalScopeId: string;
  readonly answers: readonly string[];
  readonly decision: HumanGateNode['decision'];
  readonly eligibleGroup?: string;
}

/**
 * Mints the an1_/ni1_ pair shared by every node kind that needs a durable node-instance identity.
 * Extracted so the humanGate candidate below and the task candidate in observable-plan.ts derive
 * identity through one function.
 */
export const mintNodeInstanceIdentity = (
  schemaVersion: number,
  nodeKind: PipelineNode['kind'],
  nodePath: string,
  context: Pick<ObservableTraversalContext, 'logicalScopeId' | 'pipelineId'>,
): { readonly authoredNodeId: string; readonly id: string } => {
  const authoredNodeId = createAuthoredNodeId({
    schemaVersion,
    pipelineId: context.pipelineId,
    nodePath,
    nodeKind,
  });
  return {
    authoredNodeId,
    id: createNodeInstanceId({
      scopeId: context.logicalScopeId,
      authoredNodeId,
    }),
  };
};

const buildObservableGateCandidate = (
  node: Extract<PipelineNode, { readonly kind: 'humanGate' }>,
  nodePath: string,
  context: ObservableTraversalContext,
  schemaVersion: number,
): ObservableGateCandidate => {
  const { authoredNodeId, id } = mintNodeInstanceIdentity(
    schemaVersion,
    node.kind,
    nodePath,
    context,
  );
  return {
    id,
    scopeId: context.logicalScopeId,
    authoredNodeId,
    pipelineId: context.pipelineId,
    nodePath,
    displayPath: observableDisplayPath(context, nodePath),
    physicalScopeId: context.physicalScopeId,
    answers: node.answers,
    decision: node.decision,
    ...(node.eligibleGroup === undefined ? {} : { eligibleGroup: node.eligibleGroup }),
  };
};

/** Owns humanGate candidate identity and the duplicate-instance check, a sibling of ObservableMapItems. */
export class ObservableGateCandidates {
  private readonly candidates = new Map<string, ObservableGateCandidate>();

  get byNodeInstanceId(): ReadonlyMap<string, ObservableGateCandidate> {
    return this.candidates;
  }

  register(
    node: Extract<PipelineNode, { readonly kind: 'humanGate' }>,
    nodePath: string,
    context: ObservableTraversalContext,
    schemaVersion: number,
  ): void {
    const candidate = buildObservableGateCandidate(node, nodePath, context, schemaVersion);
    if (this.candidates.has(candidate.id)) {
      throw new Error('Observable plan contains duplicate gate instances.');
    }
    this.candidates.set(candidate.id, candidate);
  }
}
