import type { ParallelJoinPolicy } from '../../contracts/pipeline/pipeline-node.js';
import type { ParallelBranchResult } from './parallel-branch-runner.js';

export interface ParallelJoinDecision {
  readonly outcome: 'succeeded' | 'failed';
  readonly observedBranchKeys: readonly string[];
  readonly outputEligibleBranchKeys: readonly string[];
}

export interface ParallelJoinState {
  readonly settlements: readonly ParallelBranchResult[];
  readonly decision?: ParallelJoinDecision;
}

export const initialParallelJoinState = (): ParallelJoinState => ({ settlements: [] });

const successfulCount = (
  policy: ParallelJoinPolicy,
  settlements: readonly ParallelBranchResult[],
): number =>
  settlements.filter(({ outcome }) => policy.successfulOutcomes.includes(outcome)).length;

const decisionOutcome = (
  policy: ParallelJoinPolicy,
  branchCount: number,
  settlements: readonly ParallelBranchResult[],
): ParallelJoinDecision['outcome'] | undefined => {
  const successful = successfulCount(policy, settlements);
  const unsettled = branchCount - settlements.length;
  switch (policy.kind) {
    case 'all':
      if (successful < settlements.length) {
        return 'failed';
      }
      return unsettled === 0 ? 'succeeded' : undefined;
    case 'any':
      if (successful > 0) {
        return 'succeeded';
      }
      return unsettled === 0 ? 'failed' : undefined;
    case 'threshold':
      if (successful >= policy.count) {
        return 'succeeded';
      }
      return successful + unsettled < policy.count ? 'failed' : undefined;
  }
  policy satisfies never;
  return undefined;
};

export const settleParallelBranch = (
  policy: ParallelJoinPolicy,
  authoredBranchKeys: readonly string[],
  state: ParallelJoinState,
  settlement: ParallelBranchResult,
): ParallelJoinState => {
  if (!authoredBranchKeys.includes(settlement.key)) {
    throw new Error(`Parallel branch ${settlement.key} is not authored by the join.`);
  }
  if (state.settlements.some(({ key }) => key === settlement.key)) {
    throw new Error(`Parallel branch ${settlement.key} settled more than once.`);
  }

  const settlements = [...state.settlements, settlement];
  if (state.decision !== undefined) {
    return { settlements, decision: state.decision };
  }
  const outcome = decisionOutcome(policy, authoredBranchKeys.length, settlements);
  if (outcome === undefined) {
    return { settlements };
  }
  const observed = new Set(settlements.map(({ key }) => key));
  return {
    settlements,
    decision: {
      outcome,
      observedBranchKeys: settlements.map(({ key }) => key),
      outputEligibleBranchKeys: authoredBranchKeys.filter((key) => observed.has(key)),
    },
  };
};

export const eligibleParallelResults = (
  state: ParallelJoinState,
): readonly ParallelBranchResult[] => {
  if (state.decision === undefined) {
    throw new Error('Parallel join has no durable decision.');
  }
  const byKey = new Map(state.settlements.map((result) => [result.key, result]));
  return state.decision.outputEligibleBranchKeys.map((key) => {
    const result = byKey.get(key);
    if (result === undefined) {
      throw new Error(`Parallel join eligible branch ${key} has no settlement.`);
    }
    return result;
  });
};
