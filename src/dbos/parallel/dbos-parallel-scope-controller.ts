import { DBOS, type WorkflowHandle } from '@dbos-inc/dbos-sdk';

import type { ParallelNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ParallelBranchResult as ParallelBranchWorkflowResult } from '../../contracts/workflow/parallel-branch-result.js';
import type { ParallelBranchWorkflowInput } from '../../contracts/workflow/parallel-branch-workflow-input.js';
import {
  createAuthoredNodeId,
  createNodeInstanceId,
  createParallelBranchScopeId,
} from '../../pipeline/identity/execution-identity.js';
import type { PipelineExecutionContext } from '../../pipeline/interpreter/interpreter-context.js';
import type { ParallelBranch } from '../../pipeline/parallel/parallel-branch-runner.js';
import type { SettledParallelBranch } from '../../pipeline/parallel/parallel-settlement-reducer.js';
import { parseParallelBranchResult } from '../../validation/parallel-branch-result.validator.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import { isScopeWorkflowId, scopeWorkflowId } from '../workflow-id.js';
import type { ParallelBranchWorkflowProvider } from '../workflows/parallel-branch-workflow-provider.js';

export type ActiveBranchDisposition = ParallelBranchWorkflowInput['disposition'] | 'discarded';

export interface ActiveParallelBranch {
  readonly branch: ParallelBranch;
  readonly disposition: ActiveBranchDisposition;
  readonly handle: WorkflowHandle<ParallelBranchWorkflowResult>;
}

export interface ParallelBranchScopeState {
  readonly node: ParallelNode;
  readonly context: PipelineExecutionContext;
  readonly nodePath: string;
  readonly pending: ParallelBranch[];
  readonly active: Map<string, ActiveParallelBranch>;
}

export class DbosParallelScopeController {
  constructor(
    private readonly workflows: ParallelBranchWorkflowProvider,
    private readonly coordinator: RunCoordinatorClient,
  ) {}

  async startNext(
    state: ParallelBranchScopeState,
    disposition: ParallelBranchWorkflowInput['disposition'],
  ): Promise<void> {
    const branch = state.pending.shift();
    if (branch === undefined) {
      return;
    }
    const { context, nodePath } = state;
    const authoredNodeId = this.authoredNodeId(context, nodePath);
    const scopeId = createParallelBranchScopeId({
      parentScopeId: context.scopeId,
      authoredNodeId,
      branchKey: branch.key,
    });
    const parentWorkflowId = DBOS.workflowID;
    if (parentWorkflowId === undefined || !isScopeWorkflowId(parentWorkflowId)) {
      throw new Error('Parallel branch parent has no workflow ID.');
    }
    const workflowId = scopeWorkflowId(scopeId);
    const startFence = await this.coordinator.admitScope(workflowId);
    const input: ParallelBranchWorkflowInput = {
      runId: context.runId,
      scopeId,
      branchKey: branch.key,
      node: branch.node,
      pipelineId: context.pipelineId,
      pipelineInput: context.pipelineInput,
      runtimePath: context.runtimePath,
      parentPath: nodePath,
      ...(context.nodePathPrefix === undefined || context.nodePathPrefix.length === 0
        ? {}
        : { nodePathPrefix: context.nodePathPrefix }),
      ...(context.iterationInput === undefined ? {} : { iterationInput: context.iterationInput }),
      ...(context.mapItem === undefined ? {} : { mapItem: context.mapItem }),
      inheritedOutputs: [...context.outputs].map(([path, output]) => ({ path, output })),
      maximumParallelism: context.maximumParallelism,
      parentWorkflowId,
      disposition,
      startFence,
    };
    const handle = await DBOS.startWorkflow(this.workflows.get(), {
      workflowID: workflowId,
    })(input);
    if (handle.workflowID !== workflowId) {
      throw new Error('Parallel branch started with an unexpected workflow ID.');
    }
    state.active.set(workflowId, { branch, disposition, handle });
  }

  async settleFirst(active: Map<string, ActiveParallelBranch>): Promise<SettledParallelBranch> {
    const handle = await DBOS.waitFirst(
      [...active.values()].map(({ handle: childHandle }) => childHandle),
    );
    const branch = active.get(handle.workflowID);
    if (branch === undefined) {
      throw new Error('DBOS completed an unknown parallel branch workflow.');
    }
    const result = parseParallelBranchResult(await branch.handle.getResult());
    if (result.key !== branch.branch.key) {
      throw new Error('Parallel branch workflow returned another branch identity.');
    }
    active.delete(handle.workflowID);
    return { disposition: branch.disposition, result };
  }

  nodeInstanceId(context: PipelineExecutionContext, nodePath: string): string {
    return createNodeInstanceId({
      scopeId: context.scopeId,
      authoredNodeId: this.authoredNodeId(context, nodePath),
    });
  }

  async cancelAndDiscardActive(
    active: Map<string, ActiveParallelBranch>,
    nodeInstanceId: string,
  ): Promise<void> {
    const workflowIds = [...active.keys()];
    for (const [workflowId, branch] of active) {
      active.set(workflowId, { ...branch, disposition: 'discarded' });
    }
    await this.coordinator.cancelScopes(workflowIds, nodeInstanceId);
  }

  private authoredNodeId(context: PipelineExecutionContext, nodePath: string): string {
    return createAuthoredNodeId({
      schemaVersion: context.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: 'parallel',
    });
  }
}
