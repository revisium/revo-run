import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkflowHandle } from '@dbos-inc/dbos-sdk';

import type { ParallelBranchV2Result } from '../../contracts/workflow/parallel-branch-v2-result.js';
import type { ParallelBranchWorkflowV2Input } from '../../contracts/workflow/parallel-branch-workflow-v2-input.js';
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
import type { RunCoordinatorV2Client } from '../coordination/run-coordinator-v2-client.js';
import { ScopeCancellationError } from '../coordination/run-coordinator-v2-client.js';
import { scopeWorkflowV2Id } from '../workflow-id.js';
import type { ParallelBranchWorkflowV2Provider } from '../workflows/parallel-branch-workflow-v2-provider.js';

interface ActiveBranch {
  readonly branch: ParallelBranch;
  readonly capacity: number;
  readonly handle: WorkflowHandle<ParallelBranchV2Result>;
}

const capacities = (total: number, branches: number): readonly number[] => {
  const base = Math.floor(total / branches);
  const remainder = total % branches;
  return Array.from({ length: branches }, (_, index) => base + (index < remainder ? 1 : 0));
};

export class DbosParallelBranchRunnerV2 implements ParallelBranchRunner {
  readonly supportsRemainingCancellation = false;
  constructor(
    private readonly workflows: ParallelBranchWorkflowV2Provider,
    private readonly coordinator: RunCoordinatorV2Client,
  ) {}

  async execute(
    branches: readonly ParallelBranch[],
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<readonly ParallelBranchResult[]> {
    const pending = [...branches];
    const active = new Map<string, ActiveBranch>();
    const completed = new Map<string, ParallelBranchResult>();
    const activeCount = Math.min(context.maximumParallelism, pending.length);
    await this.startCapacities(
      capacities(context.maximumParallelism, activeCount),
      pending,
      active,
      context,
      parentPath,
    );
    await this.drain(pending, active, completed, context, parentPath);
    return branches.map(({ key }) => {
      const result = completed.get(key);
      if (result === undefined) {
        throw new Error(`Parallel branch ${key} has no result.`);
      }
      return result;
    });
  }

  private async startCapacities(
    remaining: readonly number[],
    pending: ParallelBranch[],
    active: Map<string, ActiveBranch>,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<void> {
    const [capacity, ...rest] = remaining;
    if (capacity === undefined) {
      return;
    }
    await this.startNext(pending, active, context, parentPath, capacity);
    await this.startCapacities(rest, pending, active, context, parentPath);
  }

  private async drain(
    pending: ParallelBranch[],
    active: Map<string, ActiveBranch>,
    completed: Map<string, ParallelBranchResult>,
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<void> {
    if (active.size === 0) {
      return;
    }
    const handle = await DBOS.waitFirst(
      [...active.values()].map(({ handle: branchHandle }) => branchHandle),
    );
    const branch = active.get(handle.workflowID);
    if (branch === undefined) {
      throw new Error('DBOS completed an unknown parallel branch workflow.');
    }
    const result = await branch.handle.getResult();
    if (result.status === 'cancelled') {
      throw new ScopeCancellationError('Parallel branch was cancelled.');
    }
    completed.set(branch.branch.key, {
      key: result.key,
      outcome: result.outcome,
      outputs: result.outputs,
    });
    active.delete(branch.handle.workflowID);
    await this.startNext(pending, active, context, parentPath, branch.capacity);
    await this.drain(pending, active, completed, context, parentPath);
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
    const parentWorkflowId = DBOS.workflowID;
    if (parentWorkflowId === undefined || !parentWorkflowId.startsWith('rr:scope:v2:')) {
      throw new Error('Parallel branch parent has no v2 workflow ID.');
    }
    const input: ParallelBranchWorkflowV2Input = {
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
      parentWorkflowId,
    };
    const workflowId = scopeWorkflowV2Id(scopeId);
    const handle = await this.coordinator.registerScope(workflowId, () =>
      DBOS.startWorkflow(this.workflows.get(), {
        workflowID: workflowId,
      })(input),
    );
    if (handle.workflowID !== workflowId) {
      throw new Error('Parallel branch started with an unexpected workflow ID.');
    }
    active.set(handle.workflowID, { branch, capacity, handle });
  }
}
