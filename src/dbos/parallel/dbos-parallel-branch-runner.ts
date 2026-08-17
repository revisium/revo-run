import { isDeepStrictEqual } from 'node:util';

import { DBOS } from '@dbos-inc/dbos-sdk';

import type { ParallelNode } from '../../contracts/pipeline/pipeline-node.js';
import type { DurableParallelJoinDecision } from '../../contracts/workflow/parallel-join-decision.js';
import type { PipelineExecutionContext } from '../../pipeline/interpreter/interpreter-context.js';
import { runtimePath } from '../../pipeline/interpreter/node-path.js';
import type {
  ParallelBranchRunner,
  ParallelExecutionResult,
} from '../../pipeline/parallel/parallel-branch-runner.js';
import {
  completeParallelSettlement,
  initialParallelAdmissionPlan,
  initialParallelSettlementState,
  reduceParallelSettlement,
  type ParallelSettlementAction,
  type ParallelSettlementContext,
  type ParallelSettlementSnapshot,
  type ParallelSettlementState,
} from '../../pipeline/parallel/parallel-settlement-reducer.js';
import { parseDurableParallelJoinDecision } from '../../validation/parallel-join-decision.validator.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import { parallelJoinDecisionStepName } from '../dbos-names.js';
import type { ParallelBranchWorkflowProvider } from '../workflows/parallel-branch-workflow-provider.js';
import {
  DbosParallelScopeController,
  type ParallelBranchScopeState,
} from './dbos-parallel-scope-controller.js';

export class DbosParallelBranchRunner implements ParallelBranchRunner {
  private readonly scopes: DbosParallelScopeController;

  constructor(workflows: ParallelBranchWorkflowProvider, coordinator: RunCoordinatorClient) {
    this.scopes = new DbosParallelScopeController(workflows, coordinator);
  }

  async execute(
    node: ParallelNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<ParallelExecutionResult> {
    const scope: ParallelBranchScopeState = {
      node,
      context,
      nodePath,
      pending: Object.entries(node.branches).map(([key, branch]) => ({ key, node: branch })),
      active: new Map(),
    };
    const settlement = this.settlementContext(scope);
    await this.executeActions(
      scope,
      initialParallelAdmissionPlan(context.maximumParallelism, scope.pending.length),
    );
    const state = await this.settleActive(scope, settlement, initialParallelSettlementState());
    return completeParallelSettlement(state);
  }

  private async settleActive(
    scope: ParallelBranchScopeState,
    settlement: ParallelSettlementContext,
    state: ParallelSettlementState,
  ): Promise<ParallelSettlementState> {
    if (scope.active.size === 0) {
      return state;
    }
    const settled = await this.scopes.settleFirst(scope.active);
    const transition = reduceParallelSettlement(settlement, this.snapshot(scope), state, settled);
    await this.executeActions(scope, transition.actions);
    return this.settleActive(scope, settlement, transition.state);
  }

  private async executeActions(
    scope: ParallelBranchScopeState,
    actions: readonly ParallelSettlementAction[],
    index = 0,
  ): Promise<void> {
    const action = actions[index];
    if (action === undefined) {
      return;
    }
    switch (action.kind) {
      case 'admitNext':
        await this.scopes.startNext(scope, action.disposition);
        break;
      case 'cancelActive':
        await this.scopes.cancelAndDiscardActive(scope.active, action.nodeInstanceId);
        break;
      case 'discardPending':
        scope.pending.splice(0);
        break;
      case 'persistJoinDecision':
        await this.persistDecision(scope, action.decision);
        break;
    }
    await this.executeActions(scope, actions, index + 1);
  }

  private settlementContext(scope: ParallelBranchScopeState): ParallelSettlementContext {
    return {
      join: scope.node.join,
      branchKeys: Object.keys(scope.node.branches),
      scopeId: scope.context.scopeId,
      nodeInstanceId: this.scopes.nodeInstanceId(scope.context, scope.nodePath),
    };
  }

  private snapshot(scope: ParallelBranchScopeState): ParallelSettlementSnapshot {
    return {
      activeCount: scope.active.size,
      pendingBranchKeys: scope.pending.map(({ key }) => key),
    };
  }

  private async persistDecision(
    scope: ParallelBranchScopeState,
    expected: DurableParallelJoinDecision,
  ): Promise<void> {
    const stored = parseDurableParallelJoinDecision(
      await DBOS.runStep(async () => expected, {
        name: parallelJoinDecisionStepName(runtimePath(scope.context, scope.nodePath)),
        retriesAllowed: false,
      }),
    );
    if (!isDeepStrictEqual(stored, expected)) {
      throw new Error('Stored parallel join decision does not match the decisive prefix.');
    }
  }
}
