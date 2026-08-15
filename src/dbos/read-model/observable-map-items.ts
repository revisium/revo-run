import { Equal } from 'typebox/value';

import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../../contracts/run/execution-plan.js';
import type { MapItemWorkflowInput } from '../../contracts/workflow/map-item-workflow-input.js';
import { readJsonPointer } from '../../pipeline/data/json-pointer.js';
import {
  createAuthoredNodeId,
  createMapItemScopeId,
  createNodeInstanceId,
} from '../../pipeline/identity/execution-identity.js';
import { encodeMapItemPathSegment } from '../../pipeline/map/map-item-path.js';
import { scopeWorkflowId } from '../workflow-id.js';
import type {
  ObservableMapCandidate,
  ObservableScopeCandidate,
  ObservableTraversalContext,
} from './observable-plan-model.js';

interface ObservableMapTemplate {
  readonly node: Extract<PipelineNode, { readonly kind: 'map' }>;
  readonly nodePath: string;
  readonly parentScopeId: string;
  readonly scopeId: string;
  readonly physicalScopeId: string;
  readonly pipelineId: string;
  readonly displayPath: string;
  readonly nodeInstanceId: string;
  readonly authoredNodeId: string;
  readonly itemScopeIds: Map<string, string>;
}

export interface MapTemplateContext {
  readonly parentScopeId: string;
  readonly physicalScopeId: string;
  readonly pipelineId: string;
  readonly displayPath: string;
}

interface MapItemOperations {
  readonly getScope: (scopeId: string) => ObservableScopeCandidate | undefined;
  readonly addScope: (candidate: ObservableScopeCandidate) => void;
  readonly walkBody: (
    node: PipelineNode,
    parentPath: string,
    context: ObservableTraversalContext,
  ) => void;
}

const templateKey = (pipelineId: string, parentScopeId: string, nodePath: string): string =>
  `${pipelineId}\0${parentScopeId}\0${nodePath}`;

export class ObservableMapItems {
  private readonly templates = new Map<string, ObservableMapTemplate>();

  constructor(private readonly plan: ExecutionPlan) {}

  register(
    node: Extract<PipelineNode, { readonly kind: 'map' }>,
    nodePath: string,
    context: MapTemplateContext,
  ): ObservableMapCandidate {
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: this.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: 'map',
    });
    const template: ObservableMapTemplate = {
      node,
      nodePath,
      ...context,
      scopeId: context.parentScopeId,
      nodeInstanceId: createNodeInstanceId({
        scopeId: context.parentScopeId,
        authoredNodeId,
      }),
      authoredNodeId,
      itemScopeIds: new Map(),
    };
    const key = templateKey(context.pipelineId, context.parentScopeId, nodePath);
    const existing = this.templates.get(key);
    if (existing !== undefined) {
      if (!Equal(existing.node, node)) {
        throw new Error('Observable plan contains conflicting map templates.');
      }
      return existing;
    }
    this.templates.set(key, template);
    return template;
  }

  add(
    input: MapItemWorkflowInput,
    operations: MapItemOperations,
  ): Extract<ObservableScopeCandidate, { readonly kind: 'mapItem' }> {
    const template = this.templateFor(input);
    const existing = operations.getScope(input.scopeId);
    if (existing !== undefined) {
      if (existing.kind !== 'mapItem') {
        throw new Error('Map item scope identity collides with another scope.');
      }
      return existing;
    }
    const displayPath = `${template.displayPath}[${encodeMapItemPathSegment(input.itemKey)}]`;
    const candidate = {
      kind: 'mapItem' as const,
      id: input.scopeId,
      parentScopeId: template.parentScopeId,
      parentWorkflowId: input.parentWorkflowId,
      pipelineId: template.pipelineId,
      displayPath,
      physicalScopeId: input.scopeId,
      mapIdentity: {
        node: template.node,
        nodePath: template.nodePath,
        mapNodeInstanceId: template.nodeInstanceId,
        sourceIndex: input.sourceIndex,
        itemKey: input.itemKey,
        disposition: input.disposition,
      },
    };
    template.itemScopeIds.set(input.itemKey, input.scopeId);
    operations.addScope(candidate);
    operations.walkBody(template.node.body, template.nodePath, {
      logicalScopeId: input.scopeId,
      physicalScopeId: input.scopeId,
      pipelineId: template.pipelineId,
      runtimePath: displayPath,
      nodePathPrefix: template.nodePath,
    });
    return candidate;
  }

  private templateFor(input: MapItemWorkflowInput): ObservableMapTemplate {
    const template = this.templates.get(
      templateKey(input.pipelineId, input.parentScopeId, input.parentPath),
    );
    if (template === undefined) {
      throw new Error('Map item is not present in the admitted plan.');
    }
    const selected = readJsonPointer(input.item, template.node.itemKeyPath);
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: this.plan.schemaVersion,
      pipelineId: template.pipelineId,
      nodePath: template.nodePath,
      nodeKind: 'map',
    });
    const expectedScopeId = createMapItemScopeId({
      parentScopeId: template.parentScopeId,
      authoredNodeId,
      itemKey: input.itemKey,
    });
    const expectedDisplayPath = `${template.displayPath}[${encodeMapItemPathSegment(input.itemKey)}]`;
    if (
      input.scopeId !== expectedScopeId ||
      input.mapNodeInstanceId !== template.nodeInstanceId ||
      input.runtimePath !== expectedDisplayPath ||
      input.parentWorkflowId !== scopeWorkflowId(template.physicalScopeId) ||
      !Equal(input.node, template.node.body) ||
      !selected.found ||
      selected.value !== input.itemKey ||
      template.itemScopeIds.has(input.itemKey)
    ) {
      throw new Error('Map item durable identity is invalid.');
    }
    return template;
  }
}
