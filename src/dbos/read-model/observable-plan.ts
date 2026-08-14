import { childNodePath, pipelineNodePath } from '../../contracts/pipeline/node-path.js';
import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../../contracts/run/execution-plan.js';
import {
  createAuthoredNodeId,
  createNodeInstanceId,
  createParallelBranchScopeId,
  createRootScopeId,
  createSubpipelineScopeId,
} from '../../pipeline/identity/execution-identity.js';
import { runWorkflowId, scopeWorkflowId } from '../workflow-id.js';

export interface ParallelScopeIdentity {
  readonly branchKey: string;
  readonly node: PipelineNode;
  readonly pipelineId: string;
  readonly runtimePath: string;
  readonly parentPath: string;
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

export interface ObservablePlan {
  readonly rootScopeId: string;
  readonly scopes: ReadonlyMap<string, ObservableScopeCandidate>;
  readonly nodesByDisplayPath: ReadonlyMap<string, ObservableNodeCandidate>;
  readonly parallelNodesByDisplayPath: ReadonlyMap<string, ObservableParallelCandidate>;
}

interface TraversalContext {
  readonly logicalScopeId: string;
  readonly physicalScopeId: string;
  readonly pipelineId: string;
  readonly runtimePath: string;
}

const displayPath = (context: TraversalContext, nodePath: string): string =>
  nodePath.length === 0 ? context.runtimePath : `${context.runtimePath}/${nodePath}`;

class ObservablePlanBuilder {
  private readonly plan: ExecutionPlan;
  private readonly scopeCandidates = new Map<string, ObservableScopeCandidate>();
  private readonly nodeCandidates = new Map<string, ObservableNodeCandidate>();
  private readonly parallelCandidates = new Map<string, ObservableParallelCandidate>();

  constructor(plan: ExecutionPlan, runId: string) {
    this.plan = plan;
    const rootScopeId = createRootScopeId({ runId, rootPipelineId: plan.rootPipelineId });
    this.addScope({
      id: rootScopeId,
      kind: 'root',
      pipelineId: plan.rootPipelineId,
      displayPath: plan.rootPipelineId,
      physicalScopeId: rootScopeId,
      parentWorkflowId: runWorkflowId(runId),
    });
    this.walkPipeline({
      logicalScopeId: rootScopeId,
      physicalScopeId: rootScopeId,
      pipelineId: plan.rootPipelineId,
      runtimePath: plan.rootPipelineId,
    });
  }

  build(): ObservablePlan {
    const root = [...this.scopeCandidates.values()].find(({ kind }) => kind === 'root');
    if (root === undefined) {
      throw new Error('Observable plan has no root scope.');
    }
    return {
      rootScopeId: root.id,
      scopes: this.scopeCandidates,
      nodesByDisplayPath: this.nodeCandidates,
      parallelNodesByDisplayPath: this.parallelCandidates,
    };
  }

  private walkPipeline(context: TraversalContext): void {
    const pipeline = this.plan.pipelines[context.pipelineId];
    if (pipeline === undefined) {
      throw new Error('Observable plan pipeline was not found.');
    }
    this.walkNode(pipeline.root, '', context);
  }

  private walkNode(node: PipelineNode, parentPath: string, context: TraversalContext): void {
    const nodePath = pipelineNodePath(node, parentPath);
    switch (node.kind) {
      case 'task':
        this.addTask(node, nodePath, context);
        return;
      case 'sequence':
        for (const child of node.children) {
          this.walkNode(child, parentPath, context);
        }
        return;
      case 'outcomeSwitch':
        this.walkNode(node.source, parentPath, context);
        for (const route of Object.values(node.cases)) {
          this.walkNode(route, parentPath, context);
        }
        if (node.default !== undefined) {
          this.walkNode(node.default, parentPath, context);
        }
        return;
      case 'branch':
        for (const route of Object.values(node.cases)) {
          this.walkNode(route, nodePath, context);
        }
        if (node.default !== undefined) {
          this.walkNode(node.default, nodePath, context);
        }
        return;
      case 'subpipeline':
        this.addSubpipeline(node, nodePath, context);
        return;
      case 'parallel':
        this.addParallelBranches(node, nodePath, context);
        return;
      case 'consensus':
      case 'delay':
      case 'end':
      case 'humanGate':
      case 'map':
      case 'repeat':
        return;
    }
    node satisfies never;
  }

  private addTask(
    node: Extract<PipelineNode, { readonly kind: 'task' }>,
    nodePath: string,
    context: TraversalContext,
  ): void {
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: this.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: node.kind,
    });
    const id = createNodeInstanceId({ scopeId: context.logicalScopeId, authoredNodeId });
    const candidate = {
      id,
      scopeId: context.logicalScopeId,
      authoredNodeId,
      pipelineId: context.pipelineId,
      nodePath,
      displayPath: displayPath(context, nodePath),
      physicalScopeId: context.physicalScopeId,
      awaitsHumanResolution:
        node.recovery?.reconciliation === 'required' &&
        node.recovery.unknownOutcome === 'requireHumanResolution',
    };
    const existing = this.nodeCandidates.get(candidate.displayPath);
    if (existing !== undefined && existing.id !== candidate.id) {
      throw new Error('Observable plan contains duplicate display paths.');
    }
    this.nodeCandidates.set(candidate.displayPath, candidate);
  }

  private addSubpipeline(
    node: Extract<PipelineNode, { readonly kind: 'subpipeline' }>,
    nodePath: string,
    context: TraversalContext,
  ): void {
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: this.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: node.kind,
    });
    const id = createSubpipelineScopeId({
      parentScopeId: context.logicalScopeId,
      authoredNodeId,
      invocationOrdinal: 1,
    });
    const path = displayPath(context, nodePath);
    this.addScope({
      id,
      kind: 'inlineSubpipeline',
      parentScopeId: context.logicalScopeId,
      pipelineId: node.pipelineId,
      displayPath: path,
      physicalScopeId: context.physicalScopeId,
    });
    this.walkPipeline({
      logicalScopeId: id,
      physicalScopeId: context.physicalScopeId,
      pipelineId: node.pipelineId,
      runtimePath: path,
    });
  }

  private addParallelBranches(
    node: Extract<PipelineNode, { readonly kind: 'parallel' }>,
    nodePath: string,
    context: TraversalContext,
  ): void {
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: this.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: node.kind,
    });
    const parallelDisplayPath = displayPath(context, nodePath);
    const branchScopeIds = new Map<string, string>();
    for (const [branchKey, branch] of Object.entries(node.branches)) {
      const id = createParallelBranchScopeId({
        parentScopeId: context.logicalScopeId,
        authoredNodeId,
        branchKey,
      });
      branchScopeIds.set(branchKey, id);
      this.addScope({
        id,
        kind: 'parallelBranch',
        parentScopeId: context.logicalScopeId,
        pipelineId: context.pipelineId,
        displayPath: displayPath(context, childNodePath(nodePath, branchKey)),
        physicalScopeId: id,
        parentWorkflowId: scopeWorkflowId(context.physicalScopeId),
        parallelIdentity: {
          branchKey,
          node: branch,
          pipelineId: context.pipelineId,
          runtimePath: context.runtimePath,
          parentPath: nodePath,
        },
      });
      this.walkNode(branch, nodePath, {
        logicalScopeId: id,
        physicalScopeId: id,
        pipelineId: context.pipelineId,
        runtimePath: context.runtimePath,
      });
    }
    this.parallelCandidates.set(parallelDisplayPath, {
      node,
      nodeInstanceId: createNodeInstanceId({
        scopeId: context.logicalScopeId,
        authoredNodeId,
      }),
      scopeId: context.logicalScopeId,
      physicalScopeId: context.physicalScopeId,
      branchScopeIds,
    });
  }

  private addScope(candidate: ObservableScopeCandidate): void {
    if (this.scopeCandidates.has(candidate.id)) {
      throw new Error('Observable plan contains duplicate scope identities.');
    }
    this.scopeCandidates.set(candidate.id, candidate);
  }
}

export const buildObservablePlan = (plan: ExecutionPlan, runId: string): ObservablePlan =>
  new ObservablePlanBuilder(plan, runId).build();
