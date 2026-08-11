import assert from 'node:assert/strict';

import { pipelineNodePath } from '../../../src/contracts/pipeline/node-path.js';
import type { PipelineNode } from '../../../src/contracts/pipeline/pipeline-node.js';
import type { ExecutionPlan, RunEvent } from '../../../src/index.js';
import {
  createAuthoredNodeId,
  createNodeInstanceId,
  createParallelBranchScopeId,
  createRootScopeId,
  createSubpipelineScopeId,
} from '../../../src/pipeline/identity/execution-identity.js';
import type { ExpectedRunEvent } from '../../dsl/scenario.js';

interface NodeSearchContext {
  readonly pipelineId: string;
  readonly runtimePrefix: string;
  readonly scopeId: string;
}

export class RunEventExpectations {
  private readonly capturedCursors = new Map<string, string>();
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  expectEvent(events: readonly RunEvent[], plan: ExecutionPlan, expected: ExpectedRunEvent): void {
    const expectedNodeInstanceId =
      expected.path === undefined ? undefined : this.nodeInstanceIdFor(plan, expected.path);
    const event = events.find(
      (candidate) =>
        candidate.type === expected.type &&
        (expected.path === undefined ||
          ('nodeInstanceId' in candidate.data &&
            candidate.data.nodeInstanceId === expectedNodeInstanceId)),
    );
    assert(event !== undefined);
    if (expected.captureCursorAs !== undefined) {
      this.capturedCursors.set(expected.captureCursorAs, event.cursor);
    }
  }

  expectInputResolutionFailure(
    events: readonly RunEvent[],
    plan: ExecutionPlan,
    path: string,
    errorCode: string,
  ): void {
    const nodeInstanceId = this.nodeInstanceIdFor(plan, path);
    assert(
      events.some(
        (event) =>
          event.type === 'inputResolution.failed' &&
          event.data.nodeInstanceId === nodeInstanceId &&
          event.data.errorCode === errorCode,
      ),
    );
  }

  expectCursorOrder(events: readonly RunEvent[], captures: readonly string[]): void {
    const positions = captures.map((capture) => {
      const cursor = this.capturedCursors.get(capture);
      assert(cursor !== undefined, `Cursor ${capture} was not captured.`);
      const position = events.findIndex((event) => event.cursor === cursor);
      assert(position >= 0, `Cursor ${capture} is not in the run stream.`);
      return position;
    });

    for (let index = 1; index < positions.length; index += 1) {
      const previous = positions[index - 1];
      const current = positions[index];
      assert(previous !== undefined && current !== undefined && previous < current);
    }
  }

  private nodeInstanceIdFor(plan: ExecutionPlan, path: string): string | undefined {
    const root = Object.hasOwn(plan.pipelines, plan.rootPipelineId)
      ? plan.pipelines[plan.rootPipelineId]?.root
      : undefined;
    if (root === undefined) {
      return undefined;
    }

    const scopeId = createRootScopeId({ runId: this.runId, rootPipelineId: plan.rootPipelineId });
    return this.findNodeInstanceId(
      root,
      plan,
      '',
      { pipelineId: plan.rootPipelineId, runtimePrefix: plan.rootPipelineId, scopeId },
      path,
    );
  }

  private findNodeInstanceId(
    node: PipelineNode,
    plan: ExecutionPlan,
    parentPath: string,
    context: NodeSearchContext,
    targetRuntimePath: string,
  ): string | undefined {
    const nodePath = pipelineNodePath(node, parentPath);
    const runtimePath =
      nodePath.length === 0 ? context.runtimePrefix : `${context.runtimePrefix}/${nodePath}`;
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: node.kind,
    });
    if (runtimePath === targetRuntimePath) {
      return createNodeInstanceId({ scopeId: context.scopeId, authoredNodeId });
    }

    if (node.kind === 'subpipeline') {
      const subpipeline = Object.hasOwn(plan.pipelines, node.pipelineId)
        ? plan.pipelines[node.pipelineId]
        : undefined;
      if (subpipeline === undefined) {
        return undefined;
      }
      const scopeId = createSubpipelineScopeId({
        parentScopeId: context.scopeId,
        authoredNodeId,
        invocationOrdinal: 1,
      });
      return this.findNodeInstanceId(
        subpipeline.root,
        plan,
        '',
        { pipelineId: node.pipelineId, runtimePrefix: runtimePath, scopeId },
        targetRuntimePath,
      );
    }

    if (node.kind === 'parallel') {
      for (const [branchKey, branch] of Object.entries(node.branches)) {
        const branchScopeId = createParallelBranchScopeId({
          parentScopeId: context.scopeId,
          authoredNodeId,
          branchKey,
        });
        const match = this.findNodeInstanceId(
          branch,
          plan,
          nodePath,
          { ...context, scopeId: branchScopeId },
          targetRuntimePath,
        );
        if (match !== undefined) {
          return match;
        }
      }
      return undefined;
    }

    for (const child of this.childrenOf(node)) {
      const match = this.findNodeInstanceId(child, plan, nodePath, context, targetRuntimePath);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  }

  private childrenOf(node: PipelineNode): readonly PipelineNode[] {
    switch (node.kind) {
      case 'branch':
        return [
          ...Object.values(node.cases),
          ...(node.default === undefined ? [] : [node.default]),
        ];
      case 'map':
      case 'repeat':
        return [node.body];
      case 'outcomeSwitch':
        return [
          node.source,
          ...Object.values(node.cases),
          ...(node.default === undefined ? [] : [node.default]),
        ];
      case 'sequence':
        return node.children;
      case 'consensus':
        return Object.values(node.participants);
      case 'delay':
      case 'end':
      case 'humanGate':
      case 'parallel':
      case 'subpipeline':
      case 'task':
        return [];
    }

    node satisfies never;
    return node;
  }
}
