import { isDeepStrictEqual } from 'node:util';

import { DBOS, type WorkflowHandle } from '@dbos-inc/dbos-sdk';

import type { ParallelNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ParallelBranchResult as ParallelBranchWorkflowResult } from '../../contracts/workflow/parallel-branch-result.js';
import type { ParallelBranchWorkflowInput } from '../../contracts/workflow/parallel-branch-workflow-input.js';
import type { DurableParallelJoinDecision } from '../../contracts/workflow/parallel-join-decision.js';
import {
  createAuthoredNodeId,
  createNodeInstanceId,
  createParallelBranchScopeId,
} from '../../pipeline/identity/execution-identity.js';
import type { PipelineExecutionContext } from '../../pipeline/interpreter/interpreter-context.js';
import { runtimePath } from '../../pipeline/interpreter/node-path.js';
import type {
  ParallelBranch,
  ParallelBranchRunner,
  ParallelExecutionResult,
} from '../../pipeline/parallel/parallel-branch-runner.js';
import {
  eligibleParallelResults,
  initialParallelJoinState,
  settleParallelBranch,
  type ParallelJoinState,
} from '../../pipeline/parallel/parallel-join-reducer.js';
import { parseDurableParallelJoinDecision } from '../../validation/parallel-join-decision.validator.js';
import {
  RunCoordinatorClient,
  ScopeCancellationError,
} from '../coordination/run-coordinator-client.js';
import { parallelJoinDecisionStepName } from '../dbos-names.js';
import { scopeWorkflowId } from '../workflow-id.js';
import type { ParallelBranchWorkflowProvider } from '../workflows/parallel-branch-workflow-provider.js';

interface ActiveBranch {
  readonly branch: ParallelBranch;
  readonly handle: WorkflowHandle<ParallelBranchWorkflowResult>;
}

interface ParallelProgress {
  readonly state: ParallelJoinState;
  readonly durableDecision?: DurableParallelJoinDecision;
}

export class DbosParallelBranchRunner implements ParallelBranchRunner {
  constructor(
    private readonly workflows: ParallelBranchWorkflowProvider,
    private readonly coordinator: RunCoordinatorClient,
  ) {}

  async execute(
    node: ParallelNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<ParallelExecutionResult> {
    const branches = Object.entries(node.branches).map(([key, branch]) => ({ key, node: branch }));
    const pending = [...branches];
    const active = new Map<string, ActiveBranch>();
    await this.fillInitial(pending, active, context, nodePath);
    const progress = await this.settleActive(node, context, nodePath, branches, pending, active, {
      state: initialParallelJoinState(),
    });
    if (progress.state.decision === undefined || progress.durableDecision === undefined) {
      throw new Error('Parallel branches settled without a join decision.');
    }
    return {
      outcome: progress.state.decision.outcome === 'succeeded' ? 'completed' : 'failed',
      eligibleResults: eligibleParallelResults(progress.state),
    };
  }

  private async settleActive(
    node: ParallelNode,
    context: PipelineExecutionContext,
    nodePath: string,
    branches: readonly ParallelBranch[],
    pending: ParallelBranch[],
    active: Map<string, ActiveBranch>,
    progress: ParallelProgress,
  ): Promise<ParallelProgress> {
    if (active.size === 0) {
      return progress;
    }
    const settled = await this.settleFirst(active);
    let next = progress;
    if (settled.status === 'cancelled') {
      if (progress.state.decision === undefined) {
        throw new ScopeCancellationError('Parallel branch was cancelled before its join.');
      }
    } else if (progress.state.decision === undefined) {
      const { status: _status, ...settlement } = settled;
      const state = settleParallelBranch(
        node.join,
        branches.map(({ key }) => key),
        progress.state,
        settlement,
      );
      next = { state };
      if (state.decision !== undefined) {
        const skipped = node.join.remaining === 'cancel' ? pending.map(({ key }) => key) : [];
        const durableDecision = await this.persistDecision(node, context, nodePath, state, skipped);
        next = {
          state,
          durableDecision,
        };
        if (node.join.remaining === 'cancel') {
          pending.splice(0);
          await this.coordinator.cancelScopes([...active.keys()], durableDecision.nodeInstanceId);
        }
      }
    }

    if (next.state.decision === undefined) {
      await this.startNext(pending, active, context, nodePath, 'execute');
    } else if (node.join.remaining === 'drain') {
      await this.startNext(pending, active, context, nodePath, 'settlementOnly');
    }
    return this.settleActive(node, context, nodePath, branches, pending, active, next);
  }

  private async fillInitial(
    pending: ParallelBranch[],
    active: Map<string, ActiveBranch>,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<void> {
    const count = Math.min(context.maximumParallelism, pending.length);
    await this.startInitial(count, pending, active, context, nodePath);
  }

  private async startInitial(
    remaining: number,
    pending: ParallelBranch[],
    active: Map<string, ActiveBranch>,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<void> {
    if (remaining === 0) {
      return;
    }
    await this.startNext(pending, active, context, nodePath, 'execute');
    await this.startInitial(remaining - 1, pending, active, context, nodePath);
  }

  private async settleFirst(
    active: Map<string, ActiveBranch>,
  ): Promise<ParallelBranchWorkflowResult> {
    const handle = await DBOS.waitFirst(
      [...active.values()].map(({ handle: childHandle }) => childHandle),
    );
    const branch = active.get(handle.workflowID);
    if (branch === undefined) {
      throw new Error('DBOS completed an unknown parallel branch workflow.');
    }
    const result = await branch.handle.getResult();
    if (result.key !== branch.branch.key) {
      throw new Error('Parallel branch workflow returned another branch identity.');
    }
    active.delete(handle.workflowID);
    return result;
  }

  private async startNext(
    pending: ParallelBranch[],
    active: Map<string, ActiveBranch>,
    context: PipelineExecutionContext,
    nodePath: string,
    disposition: ParallelBranchWorkflowInput['disposition'],
  ): Promise<void> {
    const branch = pending.shift();
    if (branch === undefined) {
      return;
    }
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: context.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: 'parallel',
    });
    const scopeId = createParallelBranchScopeId({
      parentScopeId: context.scopeId,
      authoredNodeId,
      branchKey: branch.key,
    });
    const parentWorkflowId = DBOS.workflowID;
    if (!parentWorkflowId?.startsWith('rr:scope:')) {
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
    active.set(workflowId, { branch, handle });
  }

  private async persistDecision(
    node: ParallelNode,
    context: PipelineExecutionContext,
    nodePath: string,
    state: ParallelJoinState,
    skippedBranchKeys: readonly string[],
  ): Promise<DurableParallelJoinDecision> {
    if (state.decision === undefined) {
      throw new Error('Parallel join decision cannot be persisted before it is decisive.');
    }
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: context.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: 'parallel',
    });
    const expected: DurableParallelJoinDecision = {
      kind: 'parallelJoinDecision',
      scopeId: context.scopeId,
      nodeInstanceId: createNodeInstanceId({ scopeId: context.scopeId, authoredNodeId }),
      outcome: state.decision.outcome,
      remaining: node.join.remaining,
      settlements: state.decision.observedBranchKeys.map((key) => {
        const settlement = state.settlements.find((candidate) => candidate.key === key);
        if (settlement === undefined) {
          throw new Error(`Parallel join settlement ${key} was not found.`);
        }
        return { key, outcome: settlement.outcome };
      }),
      outputEligibleBranchKeys: state.decision.outputEligibleBranchKeys,
      skippedBranchKeys,
    };
    const stored = parseDurableParallelJoinDecision(
      await DBOS.runStep(async () => expected, {
        name: parallelJoinDecisionStepName(runtimePath(context, nodePath)),
        retriesAllowed: false,
      }),
    );
    if (!isDeepStrictEqual(stored, expected)) {
      throw new Error('Stored parallel join decision does not match the decisive prefix.');
    }
    return stored;
  }
}
