import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkflowHandle } from '@dbos-inc/dbos-sdk';

import type { ParallelBranchWorkflowInput } from '../../contracts/workflow/parallel-branch-workflow-input.js';
import {
  createAuthoredNodeId,
  createParallelBranchScopeId,
} from '../../pipeline/identity/execution-identity.js';
import type { PipelineExecutionContext } from '../../pipeline/interpreter/interpreter-context.js';
import type {
  ParallelBranch,
  ParallelBranchResult,
  ParallelBranchRunner,
} from '../../pipeline/parallel/parallel-branch-runner.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import { scopeWorkflowId } from '../workflow-id.js';
import type { ParallelBranchWorkflowProvider } from '../workflows/parallel-branch-workflow-provider.js';

interface ActiveBranch {
  readonly branch: ParallelBranch;
  readonly capacity: number;
  readonly handle: WorkflowHandle<ParallelBranchResult>;
}

const capacities = (total: number, branches: number): readonly number[] => {
  const base = Math.floor(total / branches);
  const remainder = total % branches;
  return Array.from({ length: branches }, (_, index) => base + (index < remainder ? 1 : 0));
};

export class DbosParallelBranchRunner implements ParallelBranchRunner {
  readonly supportsRemainingCancellation = false;
  private readonly coordinator: RunCoordinatorClient;
  private readonly workflows: ParallelBranchWorkflowProvider;

  constructor(workflows: ParallelBranchWorkflowProvider, coordinator: RunCoordinatorClient) {
    this.workflows = workflows;
    this.coordinator = coordinator;
  }

  async execute(
    branches: readonly ParallelBranch[],
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<readonly ParallelBranchResult[]> {
    const pending = [...branches];
    const active = new Map<string, ActiveBranch>();
    const completed = new Map<string, ParallelBranchResult>();
    const activeCount = Math.min(context.maximumParallelism, pending.length);

    for (const capacity of capacities(context.maximumParallelism, activeCount)) {
      await this.startNext(pending, active, context, parentPath, capacity);
    }

    while (active.size > 0) {
      const handle = await DBOS.waitFirst(
        [...active.values()].map(({ handle: childHandle }) => childHandle),
      );
      const branch = active.get(handle.workflowID);
      if (branch === undefined) {
        throw new Error('DBOS completed an unknown parallel branch workflow.');
      }

      completed.set(branch.branch.key, await branch.handle.getResult());
      active.delete(branch.handle.workflowID);
      await this.startNext(pending, active, context, parentPath, branch.capacity);
    }

    return branches.map(({ key }) => {
      const result = completed.get(key);
      if (result === undefined) {
        throw new Error(`Parallel branch ${key} has no result.`);
      }
      return result;
    });
  }

  private async startNext(
    pending: ParallelBranch[],
    active: Map<string, ActiveBranch>,
    context: PipelineExecutionContext,
    parentPath: string,
    capacity: number,
  ): Promise<void> {
    const branch = pending.shift();
    if (branch === undefined) {
      return;
    }

    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: context.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath: parentPath,
      nodeKind: 'parallel',
    });
    const scopeId = createParallelBranchScopeId({
      parentScopeId: context.scopeId,
      authoredNodeId,
      branchKey: branch.key,
    });
    const input: ParallelBranchWorkflowInput = {
      runId: context.runId,
      scopeId,
      branchKey: branch.key,
      node: branch.node,
      pipelineId: context.pipelineId,
      pipelineInput: context.pipelineInput,
      runtimePath: context.runtimePath,
      parentPath,
      inheritedOutputs: [...context.outputs].map(([path, output]) => ({ path, output })),
      maximumParallelism: capacity,
    };
    const handle = await DBOS.startWorkflow(this.workflows.get(), {
      workflowID: scopeWorkflowId(scopeId),
    })(input);
    await this.coordinator.registerScope(handle.workflowID);
    active.set(handle.workflowID, { branch, capacity, handle });
  }
}
