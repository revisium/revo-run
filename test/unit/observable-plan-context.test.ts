import { describe, expect, it } from 'vitest';

import { buildObservablePlan } from '../../src/dbos/read-model/observable-plan.js';
import { runWorkflowId, scopeWorkflowId } from '../../src/dbos/workflow-id.js';
import {
  createAuthoredNodeId,
  createNodeInstanceId,
  createParallelBranchScopeId,
  createRootScopeId,
  createSubpipelineScopeId,
} from '../../src/pipeline/identity/execution-identity.js';
import { end, executionPlan, sequence, task } from '../dsl/pipeline-builder.js';

const runId = 'Context_1';
const parallel = {
  kind: 'parallel',
  key: 'checks',
  branches: { product: task('product'), security: task('security') },
  join: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
} as const;
const plan = executionPlan(
  sequence(
    task('root-work'),
    { kind: 'subpipeline', key: 'review', pipelineId: 'review' },
    end('succeeded'),
  ),
  { pipelines: { review: sequence(task('prepare'), parallel, end('succeeded')) } },
);

const authored = (
  pipelineId: string,
  nodePath: string,
  nodeKind: 'parallel' | 'subpipeline' | 'task',
) => createAuthoredNodeId({ schemaVersion: 1, pipelineId, nodePath, nodeKind });

describe('observable plan context matrix', () => {
  it('separates logical and physical scope context for root, inline, and durable branch nodes', () => {
    const observable = buildObservablePlan(plan, runId);
    const rootScopeId = createRootScopeId({ runId, rootPipelineId: 'main' });
    const subpipelineScopeId = createSubpipelineScopeId({
      parentScopeId: rootScopeId,
      authoredNodeId: authored('main', 'review', 'subpipeline'),
      invocationOrdinal: 1,
    });
    const productScopeId = createParallelBranchScopeId({
      parentScopeId: subpipelineScopeId,
      authoredNodeId: authored('review', 'checks', 'parallel'),
      branchKey: 'product',
    });

    expect(observable.scopes.get(rootScopeId)).toEqual({
      id: rootScopeId,
      kind: 'root',
      pipelineId: 'main',
      displayPath: 'main',
      physicalScopeId: rootScopeId,
      parentWorkflowId: runWorkflowId(runId),
    });
    expect(observable.scopes.get(subpipelineScopeId)).toEqual({
      id: subpipelineScopeId,
      kind: 'inlineSubpipeline',
      parentScopeId: rootScopeId,
      pipelineId: 'review',
      displayPath: 'main/review',
      physicalScopeId: rootScopeId,
    });
    expect(observable.scopes.get(productScopeId)).toEqual({
      id: productScopeId,
      kind: 'parallelBranch',
      parentScopeId: subpipelineScopeId,
      pipelineId: 'review',
      displayPath: 'main/review/checks/product',
      physicalScopeId: productScopeId,
      parentWorkflowId: scopeWorkflowId(rootScopeId),
      parallelIdentity: {
        branchKey: 'product',
        node: task('product'),
        pipelineId: 'review',
        runtimePath: 'main/review',
        parentPath: 'checks',
      },
    });

    const contexts = [
      {
        displayPath: 'main/root-work',
        pipelineId: 'main',
        nodePath: 'root-work',
        scopeId: rootScopeId,
        physicalScopeId: rootScopeId,
      },
      {
        displayPath: 'main/review/prepare',
        pipelineId: 'review',
        nodePath: 'prepare',
        scopeId: subpipelineScopeId,
        physicalScopeId: rootScopeId,
      },
      {
        displayPath: 'main/review/checks/product',
        pipelineId: 'review',
        nodePath: 'checks/product',
        scopeId: productScopeId,
        physicalScopeId: productScopeId,
      },
    ] as const;

    for (const context of contexts) {
      const candidate = observable.nodesByDisplayPath.get(context.displayPath);
      const authoredNodeId = authored(context.pipelineId, context.nodePath, 'task');
      const nodeInstanceId = createNodeInstanceId({
        scopeId: context.scopeId,
        authoredNodeId,
      });
      expect(candidate).toEqual({
        ...context,
        id: nodeInstanceId,
        authoredNodeId,
        awaitsHumanResolution: false,
      });
      expect(candidate?.id).toMatch(/^ni1_[A-Za-z0-9_-]{43}$/);
    }
  });
});
