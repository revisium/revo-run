import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { MapItemWorkflowInput } from '../../contracts/workflow/map-item-workflow-input.js';
import type { RepeatIterationWorkflowInput } from '../../contracts/workflow/repeat-iteration-workflow-input.js';
import type { ObservableGateCandidate } from './observable-gate-candidates.js';

export interface ParallelScopeIdentity {
  readonly branchKey: string;
  readonly node: PipelineNode;
  readonly pipelineId: string;
  readonly runtimePath: string;
  readonly parentPath: string;
  readonly nodePathPrefix?: string;
}

export interface RepeatScopeIdentity {
  readonly node: Extract<PipelineNode, { readonly kind: 'repeat' }>;
  readonly nodePath: string;
  readonly ordinal: number;
}

export interface MapScopeIdentity {
  readonly node: Extract<PipelineNode, { readonly kind: 'map' }>;
  readonly nodePath: string;
  readonly mapNodeInstanceId: string;
  readonly sourceIndex: number;
  readonly itemKey: string;
  readonly disposition: MapItemWorkflowInput['disposition'];
}

interface ObservableScopeCandidateBase {
  readonly id: string;
  readonly pipelineId: string;
  readonly displayPath: string;
  readonly physicalScopeId: string;
}

export type ObservableScopeCandidate =
  | (ObservableScopeCandidateBase & {
      readonly kind: 'root';
      readonly parentWorkflowId: string;
    })
  | (ObservableScopeCandidateBase & {
      readonly kind: 'inlineSubpipeline';
      readonly parentScopeId: string;
    })
  | (ObservableScopeCandidateBase & {
      readonly kind: 'parallelBranch';
      readonly parentScopeId: string;
      readonly parentWorkflowId: string;
      readonly parallelIdentity: ParallelScopeIdentity;
    })
  | (ObservableScopeCandidateBase & {
      readonly kind: 'repeatIteration';
      readonly parentScopeId: string;
      readonly parentWorkflowId: string;
      readonly repeatIdentity: RepeatScopeIdentity;
    })
  | (ObservableScopeCandidateBase & {
      readonly kind: 'mapItem';
      readonly parentScopeId: string;
      readonly parentWorkflowId: string;
      readonly mapIdentity: MapScopeIdentity;
    });

export interface ObservableNodeCandidate {
  readonly id: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly pipelineId: string;
  readonly nodePath: string;
  readonly displayPath: string;
  readonly physicalScopeId: string;
  readonly awaitsHumanResolution: boolean;
}

export interface ObservableParallelCandidate {
  readonly node: Extract<PipelineNode, { readonly kind: 'parallel' }>;
  readonly nodeInstanceId: string;
  readonly scopeId: string;
  readonly physicalScopeId: string;
  readonly branchScopeIds: ReadonlyMap<string, string>;
}

export interface ObservableMapCandidate {
  readonly node: Extract<PipelineNode, { readonly kind: 'map' }>;
  readonly authoredNodeId: string;
  readonly pipelineId: string;
  readonly nodePath: string;
  readonly nodeInstanceId: string;
  readonly scopeId: string;
  readonly physicalScopeId: string;
  readonly itemScopeIds: ReadonlyMap<string, string>;
}

export interface ObservablePlan {
  readonly rootScopeId: string;
  readonly scopes: ReadonlyMap<string, ObservableScopeCandidate>;
  readonly nodesByDisplayPath: ReadonlyMap<string, ObservableNodeCandidate>;
  readonly parallelNodesByDisplayPath: ReadonlyMap<string, ObservableParallelCandidate>;
  readonly mapNodesByDisplayPath: ReadonlyMap<string, ObservableMapCandidate>;
  readonly gatesByNodeInstanceId: ReadonlyMap<string, ObservableGateCandidate>;
  addRepeatIteration(
    input: RepeatIterationWorkflowInput,
  ): Extract<ObservableScopeCandidate, { readonly kind: 'repeatIteration' }>;
  addMapItem(
    input: MapItemWorkflowInput,
  ): Extract<ObservableScopeCandidate, { readonly kind: 'mapItem' }>;
}

export interface ObservableTraversalContext {
  readonly logicalScopeId: string;
  readonly physicalScopeId: string;
  readonly pipelineId: string;
  readonly runtimePath: string;
  readonly nodePathPrefix?: string;
}

export const observableDisplayPath = (
  context: ObservableTraversalContext,
  nodePath: string,
): string => {
  const prefix = context.nodePathPrefix;
  if (prefix === undefined || prefix.length === 0) {
    return nodePath.length === 0 ? context.runtimePath : `${context.runtimePath}/${nodePath}`;
  }
  if (nodePath === prefix) {
    return context.runtimePath;
  }
  const prefixWithSeparator = `${prefix}/`;
  if (!nodePath.startsWith(prefixWithSeparator)) {
    throw new Error('Observable node path is outside its authored prefix.');
  }
  return `${context.runtimePath}/${nodePath.slice(prefixWithSeparator.length)}`;
};
