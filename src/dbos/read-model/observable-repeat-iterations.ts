import { Equal } from 'typebox/value';

import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan } from '../../contracts/run/execution-plan.js';
import type { RepeatIterationWorkflowInput } from '../../contracts/workflow/repeat-iteration-workflow-input.js';
import {
  createAuthoredNodeId,
  createRepeatIterationScopeId,
} from '../../pipeline/identity/execution-identity.js';
import { scopeWorkflowId } from '../workflow-id.js';
import type {
  ObservableScopeCandidate,
  ObservableTraversalContext,
} from './observable-plan-model.js';

interface ObservableRepeatTemplate {
  readonly node: Extract<PipelineNode, { readonly kind: 'repeat' }>;
  readonly nodePath: string;
  readonly parentScopeId: string;
  readonly physicalScopeId: string;
  readonly pipelineId: string;
  readonly displayPath: string;
}

export interface RepeatTemplateContext {
  readonly parentScopeId: string;
  readonly physicalScopeId: string;
  readonly pipelineId: string;
  readonly displayPath: string;
}

export interface MaterializedRepeatIteration {
  readonly template: ObservableRepeatTemplate;
  readonly displayPath: string;
}

interface RepeatIterationOperations {
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

export class ObservableRepeatIterations {
  private readonly templates = new Map<string, ObservableRepeatTemplate>();

  constructor(private readonly plan: ExecutionPlan) {}

  register(
    node: Extract<PipelineNode, { readonly kind: 'repeat' }>,
    nodePath: string,
    context: RepeatTemplateContext,
  ): void {
    const key = templateKey(context.pipelineId, context.parentScopeId, nodePath);
    const template = { node, nodePath, ...context };
    const existing = this.templates.get(key);
    if (existing !== undefined && !Equal(existing.node, node)) {
      throw new Error('Observable plan contains conflicting repeat templates.');
    }
    this.templates.set(key, template);
  }

  add(
    input: RepeatIterationWorkflowInput,
    operations: RepeatIterationOperations,
  ): Extract<ObservableScopeCandidate, { readonly kind: 'repeatIteration' }> {
    const { template, displayPath } = this.materialize(input);
    const existing = operations.getScope(input.scopeId);
    if (existing !== undefined) {
      if (existing.kind !== 'repeatIteration') {
        throw new Error('Repeat iteration scope identity collides with another scope.');
      }
      return existing;
    }
    const candidate = {
      kind: 'repeatIteration' as const,
      id: input.scopeId,
      parentScopeId: template.parentScopeId,
      parentWorkflowId: input.parentWorkflowId,
      pipelineId: template.pipelineId,
      displayPath,
      physicalScopeId: input.scopeId,
      repeatIdentity: { node: template.node, nodePath: template.nodePath, ordinal: input.ordinal },
    };
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

  private materialize(input: RepeatIterationWorkflowInput): MaterializedRepeatIteration {
    const template = this.templates.get(
      templateKey(input.pipelineId, input.parentScopeId, input.parentPath),
    );
    if (template === undefined) {
      throw new Error('Repeat iteration is not present in the admitted plan.');
    }
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: this.plan.schemaVersion,
      pipelineId: template.pipelineId,
      nodePath: template.nodePath,
      nodeKind: 'repeat',
    });
    const expectedScopeId = createRepeatIterationScopeId({
      parentScopeId: template.parentScopeId,
      authoredNodeId,
      iterationOrdinal: input.ordinal,
    });
    const expectedDisplayPath = `${template.displayPath}[${input.ordinal}]`;
    if (
      input.ordinal > template.node.maximumIterations ||
      input.scopeId !== expectedScopeId ||
      input.runtimePath !== expectedDisplayPath ||
      input.parentWorkflowId !== scopeWorkflowId(template.physicalScopeId) ||
      !Equal(input.node, template.node.body)
    ) {
      throw new Error('Repeat iteration durable identity is invalid.');
    }
    return { template, displayPath: expectedDisplayPath };
  }
}
