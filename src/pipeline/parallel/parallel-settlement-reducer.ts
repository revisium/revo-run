import type { ParallelJoinPolicy } from '../../contracts/pipeline/pipeline-node.js';
import type { ParallelBranchResult as ParallelBranchWorkflowResult } from '../../contracts/workflow/parallel-branch-result.js';
import type { DurableParallelJoinDecision } from '../../contracts/workflow/parallel-join-decision.js';
import type { TerminalWorkflowResult } from '../../contracts/workflow/terminal-workflow-result.js';
import type { ParallelExecutionResult } from './parallel-branch-runner.js';
import {
  eligibleParallelResults,
  initialParallelJoinState,
  settleParallelBranch,
  type ParallelJoinState,
} from './parallel-join-reducer.js';

export type ParallelSettlementAction =
  | { readonly kind: 'admitNext'; readonly disposition: 'execute' | 'settlementOnly' }
  | { readonly kind: 'cancelActive'; readonly nodeInstanceId: string }
  | { readonly kind: 'discardPending' }
  | {
      readonly kind: 'persistJoinDecision';
      readonly decision: DurableParallelJoinDecision;
    };

export interface ParallelSettlementContext {
  readonly join: ParallelJoinPolicy;
  readonly branchKeys: readonly string[];
  readonly scopeId: string;
  readonly nodeInstanceId: string;
}

export interface ParallelSettlementSnapshot {
  readonly activeCount: number;
  readonly pendingBranchKeys: readonly string[];
}

export interface SettledParallelBranch {
  readonly disposition: 'discarded' | 'execute' | 'settlementOnly';
  readonly result: ParallelBranchWorkflowResult;
}

export interface ParallelSettlementState {
  readonly join: ParallelJoinState;
  readonly decision?: DurableParallelJoinDecision;
  readonly terminal?: TerminalWorkflowResult;
}

export interface ParallelSettlementTransition {
  readonly state: ParallelSettlementState;
  readonly actions: readonly ParallelSettlementAction[];
}

export const initialParallelSettlementState = (): ParallelSettlementState => ({
  join: initialParallelJoinState(),
});

export const initialParallelAdmissionPlan = (
  maximumParallelism: number,
  pendingCount: number,
): readonly ParallelSettlementAction[] =>
  Array.from({ length: Math.min(maximumParallelism, pendingCount) }, () => ({
    kind: 'admitNext' as const,
    disposition: 'execute' as const,
  }));

const eventBudgetFailureFrom = (
  result: ParallelBranchWorkflowResult,
): TerminalWorkflowResult | undefined =>
  result.kind === 'terminal' &&
  result.result.status === 'failed' &&
  result.result.outcome === 'event_budget_exceeded'
    ? result.result
    : undefined;

const admissionActions = (
  context: ParallelSettlementContext,
  snapshot: ParallelSettlementSnapshot,
  state: ParallelSettlementState,
): readonly ParallelSettlementAction[] => {
  // Map nextAdmission still admits when both terminal and decision are set. Parallel already
  // persisted the join inside reduce, so a terminal state must not open another slot.
  if (state.terminal !== undefined || snapshot.pendingBranchKeys.length === 0) {
    return [];
  }
  if (state.decision === undefined) {
    return [{ kind: 'admitNext', disposition: 'execute' }];
  }
  return context.join.remaining === 'drain'
    ? [{ kind: 'admitNext', disposition: 'settlementOnly' }]
    : [];
};

const stopActions = (
  context: ParallelSettlementContext,
  snapshot: ParallelSettlementSnapshot,
): readonly ParallelSettlementAction[] => [
  ...(snapshot.pendingBranchKeys.length === 0 ? [] : [{ kind: 'discardPending' as const }]),
  ...(snapshot.activeCount === 0
    ? []
    : [{ kind: 'cancelActive' as const, nodeInstanceId: context.nodeInstanceId }]),
];

const joinDecision = (
  context: ParallelSettlementContext,
  snapshot: ParallelSettlementSnapshot,
  join: ParallelJoinState,
): DurableParallelJoinDecision => {
  if (join.decision === undefined) {
    throw new Error('Parallel join decision cannot be persisted before it is decisive.');
  }
  return {
    kind: 'parallelJoinDecision',
    scopeId: context.scopeId,
    nodeInstanceId: context.nodeInstanceId,
    outcome: join.decision.outcome,
    remaining: context.join.remaining,
    settlements: join.decision.observedBranchKeys.map((key) => {
      const settlement = join.settlements.find((candidate) => candidate.key === key);
      if (settlement === undefined) {
        throw new Error(`Parallel join settlement ${key} was not found.`);
      }
      return { key, outcome: settlement.outcome };
    }),
    outputEligibleBranchKeys: join.decision.outputEligibleBranchKeys,
    skippedBranchKeys: context.join.remaining === 'cancel' ? snapshot.pendingBranchKeys : [],
  };
};

export const reduceParallelSettlement = (
  context: ParallelSettlementContext,
  snapshot: ParallelSettlementSnapshot,
  state: ParallelSettlementState,
  settled: SettledParallelBranch,
): ParallelSettlementTransition => {
  const eventBudget = eventBudgetFailureFrom(settled.result);
  if (eventBudget !== undefined) {
    return {
      state: { ...state, terminal: eventBudget },
      actions: [
        ...(snapshot.pendingBranchKeys.length === 0 ? [] : [{ kind: 'discardPending' as const }]),
        ...(state.terminal === undefined &&
        state.decision === undefined &&
        context.join.remaining === 'cancel' &&
        snapshot.activeCount > 0
          ? [{ kind: 'cancelActive' as const, nodeInstanceId: context.nodeInstanceId }]
          : []),
      ],
    };
  }
  if (settled.disposition === 'discarded' || state.terminal !== undefined) {
    // Map returns [] on discarded. Parallel still consults admissionActions because
    // cancelActive is always paired with discardPending, so pending is empty here.
    return { state, actions: admissionActions(context, snapshot, state) };
  }
  if (state.decision !== undefined) {
    if (
      context.join.remaining === 'drain' &&
      settled.disposition === 'execute' &&
      settled.result.kind === 'terminal'
    ) {
      return {
        state: { ...state, terminal: settled.result.result },
        actions:
          snapshot.pendingBranchKeys.length === 0 ? [] : [{ kind: 'discardPending' as const }],
      };
    }
    return { state, actions: admissionActions(context, snapshot, state) };
  }
  if (settled.result.kind === 'terminal') {
    return {
      state: { ...state, terminal: settled.result.result },
      actions: [
        ...(snapshot.pendingBranchKeys.length === 0 ? [] : [{ kind: 'discardPending' as const }]),
        ...(context.join.remaining === 'cancel' && snapshot.activeCount > 0
          ? [{ kind: 'cancelActive' as const, nodeInstanceId: context.nodeInstanceId }]
          : []),
      ],
    };
  }
  const join = settleParallelBranch(context.join, context.branchKeys, state.join, settled.result);
  if (join.decision === undefined) {
    const next = { ...state, join };
    return { state: next, actions: admissionActions(context, snapshot, next) };
  }
  const decision = joinDecision(context, snapshot, join);
  const decided = { ...state, join, decision };
  return {
    state: decided,
    actions: [
      { kind: 'persistJoinDecision', decision },
      ...(context.join.remaining === 'cancel'
        ? stopActions(context, snapshot)
        : admissionActions(context, snapshot, decided)),
    ],
  };
};

// Map completion can still emit persistControlDecision. Parallel already persisted in reduce.
export const completeParallelSettlement = (
  state: ParallelSettlementState,
): ParallelExecutionResult => {
  if (state.terminal !== undefined) {
    return { kind: 'terminal', result: state.terminal };
  }
  if (state.join.decision === undefined || state.decision === undefined) {
    throw new Error('Parallel branches settled without a join decision.');
  }
  return {
    kind: 'continued',
    outcome: state.join.decision.outcome === 'succeeded' ? 'completed' : 'failed',
    eligibleResults: eligibleParallelResults(state.join),
  };
};
