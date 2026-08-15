import { childNodePath, pipelineNodePath } from '../../contracts/pipeline/node-path.js';
import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../../contracts/run/execution-plan.js';
import type { MapItemWorkflowInput } from '../../contracts/workflow/map-item-workflow-input.js';
import type { RepeatIterationWorkflowInput } from '../../contracts/workflow/repeat-iteration-workflow-input.js';
import {
  createAuthoredNodeId,
  createNodeInstanceId,
  createParallelBranchScopeId,
  createRootScopeId,
  createSubpipelineScopeId,
} from '../../pipeline/identity/execution-identity.js';
import { runWorkflowId, scopeWorkflowId } from '../workflow-id.js';
import { ObservableMapItems } from './observable-map-items.js';
import {
  type ObservableNodeCandidate,
  type ObservableMapCandidate,
  type ObservableParallelCandidate,
  type ObservablePlan,
  type ObservableScopeCandidate,
  type ObservableTraversalContext,
  observableDisplayPath,
} from './observable-plan-model.js';
import { ObservableRepeatIterations } from './observable-repeat-iterations.js';

export type {
  ObservableNodeCandidate,
  ObservableParallelCandidate,
  ObservablePlan,
  ObservableScopeCandidate,
  ParallelScopeIdentity,
  RepeatScopeIdentity,
  MapScopeIdentity,
  ObservableMapCandidate,
} from './observable-plan-model.js';

class ObservablePlanBuilder {
  private readonly plan: ExecutionPlan;
  private readonly scopeCandidates = new Map<string, ObservableScopeCandidate>();
  private readonly nodeCandidates = new Map<string, ObservableNodeCandidate>();
  private readonly parallelCandidates = new Map<string, ObservableParallelCandidate>();
  private readonly repeatIterations: ObservableRepeatIterations;
  private readonly mapItems: ObservableMapItems;
  private readonly mapCandidates = new Map<string, ObservableMapCandidate>();

  constructor(plan: ExecutionPlan, runId: string) {
    this.plan = plan;
    this.repeatIterations = new ObservableRepeatIterations(plan);
    this.mapItems = new ObservableMapItems(plan);
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
      mapNodesByDisplayPath: this.mapCandidates,
      addRepeatIteration: (input) => this.addRepeatIteration(input),
      addMapItem: (input) => this.addMapItem(input),
    };
  }

  private walkPipeline(context: ObservableTraversalContext): void {
    const pipeline = this.plan.pipelines[context.pipelineId];
    if (pipeline === undefined) {
      throw new Error('Observable plan pipeline was not found.');
    }
    this.walkNode(pipeline.root, '', context);
  }

  private walkNode(
    node: PipelineNode,
    parentPath: string,
    context: ObservableTraversalContext,
  ): void {
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
      case 'repeat':
        this.addRepeatTemplate(node, nodePath, context);
        return;
      case 'map':
        this.addMapTemplate(node, nodePath, context);
        return;
      case 'consensus':
      case 'delay':
      case 'end':
      case 'humanGate':
        return;
    }
    node satisfies never;
  }

  private addTask(
    node: Extract<PipelineNode, { readonly kind: 'task' }>,
    nodePath: string,
    context: ObservableTraversalContext,
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
      displayPath: observableDisplayPath(context, nodePath),
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
    context: ObservableTraversalContext,
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
    const path = observableDisplayPath(context, nodePath);
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
      nodePathPrefix: '',
    });
  }

  private addParallelBranches(
    node: Extract<PipelineNode, { readonly kind: 'parallel' }>,
    nodePath: string,
    context: ObservableTraversalContext,
  ): void {
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: this.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: node.kind,
    });
    const parallelDisplayPath = observableDisplayPath(context, nodePath);
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
      this.walkNode(branch, nodePath, {
        logicalScopeId: id,
        physicalScopeId: id,
        pipelineId: context.pipelineId,
        runtimePath: context.runtimePath,
        ...(context.nodePathPrefix === undefined ? {} : { nodePathPrefix: context.nodePathPrefix }),
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

  private addRepeatTemplate(
    node: Extract<PipelineNode, { readonly kind: 'repeat' }>,
    nodePath: string,
    context: ObservableTraversalContext,
  ): void {
    this.repeatIterations.register(node, nodePath, {
      parentScopeId: context.logicalScopeId,
      physicalScopeId: context.physicalScopeId,
      pipelineId: context.pipelineId,
      displayPath: observableDisplayPath(context, nodePath),
    });
  }

  private addRepeatIteration(
    input: RepeatIterationWorkflowInput,
  ): Extract<ObservableScopeCandidate, { readonly kind: 'repeatIteration' }> {
    return this.repeatIterations.add(input, {
      getScope: (scopeId) => this.scopeCandidates.get(scopeId),
      addScope: (candidate) => this.addScope(candidate),
      walkBody: (node, parentPath, context) => this.walkNode(node, parentPath, context),
    });
  }

  private addMapTemplate(
    node: Extract<PipelineNode, { readonly kind: 'map' }>,
    nodePath: string,
    context: ObservableTraversalContext,
  ): void {
    const displayPath = observableDisplayPath(context, nodePath);
    const candidate = this.mapItems.register(node, nodePath, {
      parentScopeId: context.logicalScopeId,
      physicalScopeId: context.physicalScopeId,
      pipelineId: context.pipelineId,
      displayPath,
    });
    const existing = this.mapCandidates.get(displayPath);
    if (existing !== undefined && existing.nodeInstanceId !== candidate.nodeInstanceId) {
      throw new Error('Observable plan contains duplicate map display paths.');
    }
    this.mapCandidates.set(displayPath, candidate);
  }

  private addMapItem(
    input: MapItemWorkflowInput,
  ): Extract<ObservableScopeCandidate, { readonly kind: 'mapItem' }> {
    return this.mapItems.add(input, {
      getScope: (scopeId) => this.scopeCandidates.get(scopeId),
      addScope: (candidate) => this.addScope(candidate),
      walkBody: (node, parentPath, context) => this.walkNode(node, parentPath, context),
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
