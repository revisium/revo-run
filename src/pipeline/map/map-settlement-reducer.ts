import type { MapNode } from '../../contracts/pipeline/pipeline-node.js';
import type { DurableMapControlDecision } from '../../contracts/workflow/map-control-decision.js';
import type { MapItemResult } from '../../contracts/workflow/map-item-result.js';
import type { TerminalWorkflowResult } from '../../contracts/workflow/terminal-workflow-result.js';
import type { MapItemExecutionResult, PreparedMapItem } from './map-item-runner.js';
import { classifyMapItemResult, mapNodeOutput, summarizeMapItems } from './map-result-summary.js';

export interface MapSettlementContext {
  readonly failure: MapNode['failure'];
  readonly items: readonly PreparedMapItem[];
  readonly scopeId: string;
  readonly nodeInstanceId: string;
}

export interface MapSettlementSnapshot {
  readonly activeCount: number;
  readonly admitted: readonly PreparedMapItem[];
  readonly pending: readonly PreparedMapItem[];
}

export interface MapSettlementState {
  readonly eligibleResults: ReadonlyMap<string, MapItemResult>;
  readonly decision?: DurableMapControlDecision;
  readonly terminal?: TerminalWorkflowResult;
}

export interface SettledMapItem {
  readonly item: PreparedMapItem;
  readonly disposition: 'discarded' | 'execute' | 'settlementOnly';
  readonly result: MapItemResult;
}

export type MapSettlementAction =
  | { readonly kind: 'admitNext'; readonly disposition: 'execute' | 'settlementOnly' }
  | { readonly kind: 'cancelActive'; readonly nodeInstanceId: string }
  | { readonly kind: 'discardPending' }
  | {
      readonly kind: 'persistControlDecision';
      readonly decision: DurableMapControlDecision;
    };

export interface MapSettlementTransition {
  readonly state: MapSettlementState;
  readonly actions: readonly MapSettlementAction[];
}

export interface MapSettlementCompletion extends MapSettlementTransition {
  readonly result: MapItemExecutionResult;
}

export const initialMapSettlementState = (): MapSettlementState => ({
  eligibleResults: new Map(),
});

export const initialMapAdmissionPlan = (
  concurrency: number,
  pendingCount: number,
): readonly MapSettlementAction[] =>
  Array.from({ length: Math.min(concurrency, pendingCount) }, () => ({
    kind: 'admitNext' as const,
    disposition: 'execute' as const,
  }));

const itemIdentity = ({ sourceIndex, itemKey }: PreparedMapItem) => ({ sourceIndex, itemKey });

const summaryEligibleItemKeys = (
  context: MapSettlementContext,
  eligibleResults: ReadonlyMap<string, MapItemResult>,
): readonly string[] =>
  context.items.filter(({ itemKey }) => eligibleResults.has(itemKey)).map(({ itemKey }) => itemKey);

const failureDecision = (
  context: MapSettlementContext,
  snapshot: MapSettlementSnapshot,
  eligibleResults: ReadonlyMap<string, MapItemResult>,
  decisiveItem: PreparedMapItem,
): DurableMapControlDecision => {
  if (context.failure.kind !== 'failFast') {
    throw new Error('Collecting maps cannot create a failure decision.');
  }
  const remainingDisposition = context.failure.remaining;
  return {
    scopeId: context.scopeId,
    nodeInstanceId: context.nodeInstanceId,
    control: 'failureDecided',
    decisiveItemKey: decisiveItem.itemKey,
    summaryEligibleItemKeys: summaryEligibleItemKeys(context, eligibleResults),
    admitted: snapshot.admitted.map(itemIdentity),
    remaining: snapshot.pending.map((item) => ({
      ...itemIdentity(item),
      disposition: remainingDisposition,
    })),
  };
};

const allSettledDecision = (
  context: MapSettlementContext,
  snapshot: MapSettlementSnapshot,
  state: MapSettlementState,
): DurableMapControlDecision => ({
  scopeId: context.scopeId,
  nodeInstanceId: context.nodeInstanceId,
  control: 'allSettled',
  summaryEligibleItemKeys: summaryEligibleItemKeys(context, state.eligibleResults),
  admitted: snapshot.admitted.map(itemIdentity),
  remaining: [],
});

const nextAdmission = (
  context: MapSettlementContext,
  snapshot: MapSettlementSnapshot,
  state: MapSettlementState,
): readonly MapSettlementAction[] => {
  if (
    snapshot.pending.length === 0 ||
    (state.terminal !== undefined && state.decision === undefined)
  ) {
    return [];
  }
  if (state.decision === undefined) {
    return [{ kind: 'admitNext', disposition: 'execute' }];
  }
  return context.failure.kind === 'failFast' && context.failure.remaining === 'drain'
    ? [{ kind: 'admitNext', disposition: 'settlementOnly' }]
    : [];
};

const terminalTransition = (
  context: MapSettlementContext,
  snapshot: MapSettlementSnapshot,
  state: MapSettlementState,
  terminal: TerminalWorkflowResult,
): MapSettlementTransition => ({
  state: { ...state, terminal },
  actions: [
    ...(snapshot.pending.length === 0 ? [] : [{ kind: 'discardPending' as const }]),
    ...(snapshot.activeCount === 0
      ? []
      : [{ kind: 'cancelActive' as const, nodeInstanceId: context.nodeInstanceId }]),
  ],
});

const failureTransition = (
  context: MapSettlementContext,
  snapshot: MapSettlementSnapshot,
  state: MapSettlementState,
  decisiveItem: PreparedMapItem,
): MapSettlementTransition => {
  const decision = failureDecision(context, snapshot, state.eligibleResults, decisiveItem);
  const decided = { ...state, decision };
  return {
    state: decided,
    actions: [
      { kind: 'persistControlDecision', decision },
      ...(context.failure.kind === 'failFast' && context.failure.remaining === 'cancel'
        ? [
            ...(snapshot.pending.length === 0 ? [] : [{ kind: 'discardPending' as const }]),
            ...(snapshot.activeCount === 0
              ? []
              : [{ kind: 'cancelActive' as const, nodeInstanceId: context.nodeInstanceId }]),
          ]
        : nextAdmission(context, snapshot, decided)),
    ],
  };
};

export const reduceMapSettlement = (
  context: MapSettlementContext,
  snapshot: MapSettlementSnapshot,
  state: MapSettlementState,
  settled: SettledMapItem,
): MapSettlementTransition => {
  if (settled.disposition === 'discarded') {
    return { state, actions: [] };
  }
  const classified = classifyMapItemResult(settled.result);
  if (state.decision !== undefined) {
    const nextState =
      context.failure.kind === 'failFast' &&
      context.failure.remaining === 'drain' &&
      settled.disposition === 'execute' &&
      classified.kind === 'terminal' &&
      state.terminal === undefined
        ? { ...state, terminal: classified.result }
        : state;
    return { state: nextState, actions: nextAdmission(context, snapshot, nextState) };
  }
  if (classified.kind === 'terminal') {
    return terminalTransition(context, snapshot, state, classified.result);
  }
  if (classified.kind === 'settlementOnly') {
    throw new Error('Map item settled without execution before a failure decision.');
  }

  const eligibleResults = new Map(state.eligibleResults);
  eligibleResults.set(settled.item.itemKey, settled.result);
  const nextState = { ...state, eligibleResults };
  if (classified.successful || context.failure.kind === 'collect') {
    return { state: nextState, actions: nextAdmission(context, snapshot, nextState) };
  }
  return failureTransition(context, snapshot, nextState, settled.item);
};

const completedResult = (
  context: MapSettlementContext,
  state: MapSettlementState & { readonly decision: DurableMapControlDecision },
): MapItemExecutionResult => {
  if (state.terminal !== undefined) {
    return { kind: 'terminal', result: state.terminal };
  }
  const summary = summarizeMapItems(
    context.items,
    state.decision.summaryEligibleItemKeys,
    state.eligibleResults,
  );
  const outcome =
    state.decision.control === 'failureDecided'
      ? 'failed'
      : summary.failedItems === 0
        ? 'completed'
        : 'completedWithErrors';
  return { kind: 'continued', outcome, output: mapNodeOutput(summary) };
};

export const completeMapSettlement = (
  context: MapSettlementContext,
  state: MapSettlementState,
  snapshot: MapSettlementSnapshot,
): MapSettlementCompletion => {
  if (state.terminal !== undefined && state.decision === undefined) {
    return { state, actions: [], result: { kind: 'terminal', result: state.terminal } };
  }
  if (state.decision !== undefined) {
    const decided = { ...state, decision: state.decision };
    return { state: decided, actions: [], result: completedResult(context, decided) };
  }
  if (snapshot.activeCount !== 0 || snapshot.pending.length !== 0) {
    throw new Error('Map settlement completed while items were still unsettled.');
  }
  const decision = allSettledDecision(context, snapshot, state);
  const decided = { ...state, decision };
  return {
    state: decided,
    actions: [{ kind: 'persistControlDecision', decision }],
    result: completedResult(context, decided),
  };
};
