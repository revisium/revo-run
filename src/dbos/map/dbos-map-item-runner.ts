import { isDeepStrictEqual } from 'node:util';

import { DBOS } from '@dbos-inc/dbos-sdk';

import { runtimePath } from '../../pipeline/interpreter/node-path.js';
import type {
  MapItemExecution,
  MapItemExecutionResult,
  MapItemRunner,
} from '../../pipeline/map/map-item-runner.js';
import {
  completeMapSettlement,
  initialMapAdmissionPlan,
  initialMapSettlementState,
  reduceMapSettlement,
  type MapSettlementAction,
  type MapSettlementContext,
  type MapSettlementSnapshot,
  type MapSettlementState,
} from '../../pipeline/map/map-settlement-reducer.js';
import { parseDurableMapControlDecision } from '../../validation/map-control-decision.validator.js';
import { RunCoordinatorClient } from '../coordination/run-coordinator-client.js';
import { mapControlDecisionStepName } from '../dbos-names.js';
import type { MapItemWorkflowProvider } from '../workflows/map-item-workflow-provider.js';
import {
  DbosMapItemScopeController,
  type MapItemScopeState,
} from './dbos-map-item-scope-controller.js';

export class DbosMapItemRunner implements MapItemRunner {
  private readonly scopes: DbosMapItemScopeController;

  constructor(workflows: MapItemWorkflowProvider, coordinator: RunCoordinatorClient) {
    this.scopes = new DbosMapItemScopeController(workflows, coordinator);
  }

  async execute(input: MapItemExecution): Promise<MapItemExecutionResult> {
    const settlement: MapItemScopeState = {
      input,
      pending: [...input.items],
      active: new Map(),
      admitted: [],
    };
    const context = this.settlementContext(input);
    await this.executeActions(
      settlement,
      initialMapAdmissionPlan(input.node.concurrency, settlement.pending.length),
    );
    const state = await this.settleActive(settlement, context, initialMapSettlementState());
    const completion = completeMapSettlement(context, state, this.snapshot(settlement));
    await this.executeActions(settlement, completion.actions);
    return completion.result;
  }

  private async settleActive(
    settlement: MapItemScopeState,
    context: MapSettlementContext,
    state: MapSettlementState,
  ): Promise<MapSettlementState> {
    if (settlement.active.size === 0) {
      return state;
    }
    const settled = await this.scopes.settleFirst(settlement.active);
    const transition = reduceMapSettlement(context, this.snapshot(settlement), state, settled);
    await this.executeActions(settlement, transition.actions);
    return this.settleActive(settlement, context, transition.state);
  }

  private async executeActions(
    settlement: MapItemScopeState,
    actions: readonly MapSettlementAction[],
    index = 0,
  ): Promise<void> {
    const action = actions[index];
    if (action === undefined) {
      return;
    }
    switch (action.kind) {
      case 'admitNext':
        await this.scopes.startNext(settlement, action.disposition);
        break;
      case 'cancelActive':
        await this.scopes.cancelAndDiscardActive(settlement.active, action.nodeInstanceId);
        break;
      case 'discardPending':
        settlement.pending.splice(0);
        break;
      case 'persistControlDecision':
        await this.persistDecision(settlement.input, action.decision);
        break;
    }
    await this.executeActions(settlement, actions, index + 1);
  }

  private settlementContext(input: MapItemExecution): MapSettlementContext {
    return {
      failure: input.node.failure,
      items: input.items,
      scopeId: input.context.scopeId,
      nodeInstanceId: this.scopes.nodeInstanceId(input),
    };
  }

  private snapshot(settlement: MapItemScopeState): MapSettlementSnapshot {
    return {
      activeCount: settlement.active.size,
      admitted: settlement.admitted,
      pending: settlement.pending,
    };
  }

  private async persistDecision(
    input: MapItemExecution,
    expected: Extract<MapSettlementAction, { readonly kind: 'persistControlDecision' }>['decision'],
  ): Promise<void> {
    const stored = parseDurableMapControlDecision(
      await DBOS.runStep(async () => expected, {
        name: mapControlDecisionStepName(runtimePath(input.context, input.nodePath)),
        retriesAllowed: false,
      }),
    );
    if (!isDeepStrictEqual(stored, expected)) {
      throw new Error('Stored map control decision does not match the control boundary.');
    }
  }
}
