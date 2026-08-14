import { isDeepStrictEqual } from 'node:util';

import { DBOS, type WorkflowHandle } from '@dbos-inc/dbos-sdk';

import type { ParallelNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ParallelBranchResult as ParallelBranchWorkflowResult } from '../../contracts/workflow/parallel-branch-result.js';
import type { ParallelBranchWorkflowInput } from '../../contracts/workflow/parallel-branch-workflow-input.js';
import type { DurableParallelJoinDecision } from '../../contracts/workflow/parallel-join-decision.js';
import type { TerminalWorkflowResult } from '../../contracts/workflow/terminal-workflow-result.js';
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
import { parseParallelBranchResult } from '../../validation/parallel-branch-result.validator.js';
import { parseDurableParallelJoinDecision } from '../../validation/parallel-join-decision.validator.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import { parallelJoinDecisionStepName } from '../dbos-names.js';
import { scopeWorkflowId } from '../workflow-id.js';
import type { ParallelBranchWorkflowProvider } from '../workflows/parallel-branch-workflow-provider.js';

type ActiveBranchDisposition = ParallelBranchWorkflowInput['disposition'] | 'discarded';

interface ActiveBranch {
  readonly branch: ParallelBranch;
  readonly disposition: ActiveBranchDisposition;
  readonly handle: WorkflowHandle<ParallelBranchWorkflowResult>;
}

interface ParallelProgress {
  readonly state: ParallelJoinState;
  readonly durableDecision?: DurableParallelJoinDecision;
  readonly terminal?: TerminalWorkflowResult;
}

interface SettledBranch {
  readonly disposition: ActiveBranchDisposition;
  readonly result: ParallelBranchWorkflowResult;
}

interface ParallelSettlement {
  readonly node: ParallelNode;
  readonly context: PipelineExecutionContext;
  readonly nodePath: string;
  readonly branches: readonly ParallelBranch[];
  readonly pending: ParallelBranch[];
  readonly active: Map<string, ActiveBranch>;
}

const eventBudgetFailureFrom = (
  result: ParallelBranchWorkflowResult,
): TerminalWorkflowResult | undefined =>
  result.kind === 'terminal' &&
  result.result.status === 'failed' &&
  result.result.outcome === 'event_budget_exceeded'
    ? result.result
    : undefined;

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
    const progress = await this.settleActive(
      { node, context, nodePath, branches, pending, active },
      { state: initialParallelJoinState() },
    );
    if (progress.terminal !== undefined) {
      return { kind: 'terminal', result: progress.terminal };
    }
    if (progress.state.decision === undefined || progress.durableDecision === undefined) {
      throw new Error('Parallel branches settled without a join decision.');
    }
    return {
      kind: 'continued',
      outcome: progress.state.decision.outcome === 'succeeded' ? 'completed' : 'failed',
      eligibleResults: eligibleParallelResults(progress.state),
    };
  }

  private async settleActive(
    settlement: ParallelSettlement,
    progress: ParallelProgress,
  ): Promise<ParallelProgress> {
    const { active } = settlement;
    if (active.size === 0) {
      return progress;
    }
    const settled = await this.settleFirst(active);
    const next = await this.advanceProgress(settlement, progress, settled);
    await this.replenishActive(settlement, next);
    return this.settleActive(settlement, next);
  }

  private async advanceProgress(
    settlement: ParallelSettlement,
    progress: ParallelProgress,
    settled: SettledBranch,
  ): Promise<ParallelProgress> {
    const { active, context, node, nodePath, pending } = settlement;
    const eventBudgetFailure = eventBudgetFailureFrom(settled.result);
    if (eventBudgetFailure !== undefined) {
      pending.splice(0);
      if (
        progress.terminal === undefined &&
        progress.state.decision === undefined &&
        node.join.remaining === 'cancel'
      ) {
        await this.cancelAndDiscardActive(active, this.nodeInstanceId(context, nodePath));
      }
      return { ...progress, terminal: eventBudgetFailure };
    }
    if (settled.disposition === 'discarded' || progress.terminal !== undefined) {
      return progress;
    }
    if (progress.state.decision !== undefined) {
      return this.progressAfterDecision(settlement, progress, settled);
    }
    if (settled.result.kind === 'terminal') {
      pending.splice(0);
      if (node.join.remaining === 'cancel') {
        await this.cancelAndDiscardActive(active, this.nodeInstanceId(context, nodePath));
      }
      return { ...progress, terminal: settled.result.result };
    }
    return this.progressAfterContinued(settlement, progress, settled.result);
  }

  private progressAfterDecision(
    settlement: ParallelSettlement,
    progress: ParallelProgress,
    settled: SettledBranch,
  ): ParallelProgress {
    if (
      settlement.node.join.remaining !== 'drain' ||
      settled.disposition !== 'execute' ||
      settled.result.kind !== 'terminal'
    ) {
      return progress;
    }
    settlement.pending.splice(0);
    return { ...progress, terminal: settled.result.result };
  }

  private async progressAfterContinued(
    settlement: ParallelSettlement,
    progress: ParallelProgress,
    result: Extract<ParallelBranchWorkflowResult, { readonly kind: 'continued' }>,
  ): Promise<ParallelProgress> {
    const { active, branches, context, node, nodePath, pending } = settlement;
    const state = settleParallelBranch(
      node.join,
      branches.map(({ key }) => key),
      progress.state,
      result,
    );
    if (state.decision === undefined) {
      return { state };
    }

    const skipped = node.join.remaining === 'cancel' ? pending.map(({ key }) => key) : [];
    const durableDecision = await this.persistDecision(node, context, nodePath, state, skipped);
    if (node.join.remaining === 'cancel') {
      pending.splice(0);
      await this.cancelAndDiscardActive(active, durableDecision.nodeInstanceId);
    }
    return { state, durableDecision };
  }

  private async replenishActive(
    settlement: ParallelSettlement,
    progress: ParallelProgress,
  ): Promise<void> {
    const { active, context, node, nodePath, pending } = settlement;
    if (progress.terminal !== undefined) {
      pending.splice(0);
      return;
    }
    if (progress.state.decision === undefined) {
      await this.startNext(pending, active, context, nodePath, 'execute');
      return;
    }
    if (node.join.remaining === 'drain') {
      await this.startNext(pending, active, context, nodePath, 'settlementOnly');
    }
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

  private async settleFirst(active: Map<string, ActiveBranch>): Promise<SettledBranch> {
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
      ...(context.nodePathPrefix === undefined || context.nodePathPrefix.length === 0
        ? {}
        : { nodePathPrefix: context.nodePathPrefix }),
      ...(context.iterationInput === undefined ? {} : { iterationInput: context.iterationInput }),
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
    active.set(workflowId, { branch, disposition, handle });
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
    const expected: DurableParallelJoinDecision = {
      kind: 'parallelJoinDecision',
      scopeId: context.scopeId,
      nodeInstanceId: this.nodeInstanceId(context, nodePath),
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

  private nodeInstanceId(context: PipelineExecutionContext, nodePath: string): string {
    const authoredNodeId = createAuthoredNodeId({
      schemaVersion: context.plan.schemaVersion,
      pipelineId: context.pipelineId,
      nodePath,
      nodeKind: 'parallel',
    });
    return createNodeInstanceId({ scopeId: context.scopeId, authoredNodeId });
  }

  private async cancelAndDiscardActive(
    active: Map<string, ActiveBranch>,
    nodeInstanceId: string,
  ): Promise<void> {
    const workflowIds = [...active.keys()];
    for (const [workflowId, branch] of active) {
      active.set(workflowId, { ...branch, disposition: 'discarded' });
    }
    await this.coordinator.cancelScopes(workflowIds, nodeInstanceId);
  }
}
