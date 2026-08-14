import type {
  ParallelJoinObservation,
  SkippedParallelBranch,
} from '../../contracts/run/run-details.js';
import type { DurableParallelJoinDecision } from '../../contracts/workflow/parallel-join-decision.js';
import {
  initialParallelJoinState,
  settleParallelBranch,
} from '../../pipeline/parallel/parallel-join-reducer.js';
import type { ObservableParallelCandidate } from './observable-plan.js';

export interface ParallelJoinProjection {
  readonly observation: ParallelJoinObservation;
  readonly skippedBranches: readonly SkippedParallelBranch[];
}

export const mapParallelJoinObservation = (
  candidate: ObservableParallelCandidate,
  decision: DurableParallelJoinDecision,
  admittedBranchKeys: ReadonlySet<string>,
  authoritativeTerminal = true,
): ParallelJoinProjection => {
  if (
    decision.scopeId !== candidate.scopeId ||
    decision.nodeInstanceId !== candidate.nodeInstanceId ||
    decision.remaining !== candidate.node.join.remaining
  ) {
    throw new Error('Parallel join decision identity is invalid.');
  }
  const authoredBranchKeys = Object.keys(candidate.node.branches);
  let replay = initialParallelJoinState();
  for (const settlement of decision.settlements) {
    if (replay.decision !== undefined) {
      throw new Error(
        'Parallel join decision contains a late settlement after its decisive prefix.',
      );
    }
    replay = settleParallelBranch(candidate.node.join, authoredBranchKeys, replay, {
      ...settlement,
      outputs: [],
    });
  }
  const replayedDecision = replay.decision;
  if (replayedDecision === undefined) {
    throw new Error('Parallel join decision settlement prefix is not decisive.');
  }
  const expectedSkipped =
    decision.remaining === 'cancel'
      ? authoredBranchKeys.filter((key) => !admittedBranchKeys.has(key))
      : [];
  if (
    replayedDecision.outcome !== decision.outcome ||
    !sameKeys(
      replayedDecision.observedBranchKeys,
      decision.settlements.map(({ key }) => key),
    ) ||
    !sameKeys(replayedDecision.outputEligibleBranchKeys, decision.outputEligibleBranchKeys) ||
    !sameKeys(decision.skippedBranchKeys, expectedSkipped) ||
    authoredBranchKeys.some(
      (key) => admittedBranchKeys.has(key) && decision.skippedBranchKeys.includes(key),
    ) ||
    decision.settlements.some(({ key }) => !admittedBranchKeys.has(key)) ||
    (authoritativeTerminal &&
      decision.remaining === 'drain' &&
      authoredBranchKeys.some((key) => !admittedBranchKeys.has(key)))
  ) {
    throw new Error('Parallel join decision semantics are invalid.');
  }
  return {
    observation: {
      scopeId: decision.scopeId,
      nodeInstanceId: decision.nodeInstanceId,
      outcome: decision.outcome,
      remaining: decision.remaining,
      observedBranchKeys: replayedDecision.observedBranchKeys,
      outputEligibleBranchKeys: decision.outputEligibleBranchKeys,
      skippedBranchKeys: decision.skippedBranchKeys,
    },
    skippedBranches: decision.skippedBranchKeys.map((branchKey) => {
      const scopeId = candidate.branchScopeIds.get(branchKey);
      if (scopeId === undefined) {
        throw new Error('Skipped parallel branch has no authored scope.');
      }
      return {
        kind: 'parallelBranch',
        disposition: 'skipped',
        reason: 'join-decided',
        scopeId,
        parentScopeId: candidate.scopeId,
        nodeInstanceId: candidate.nodeInstanceId,
        branchKey,
      };
    }),
  };
};

const sameKeys = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((key, index) => key === right[index]);
