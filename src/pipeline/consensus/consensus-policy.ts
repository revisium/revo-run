/**
 * Pure consensus policy: vote admission and verdict reduction.
 * DBOS-free. The coordinator owns durability and remaining cancel/drain.
 */

import type {
  ConsensusVote,
  ConsensusVoteLiteral,
} from '../../contracts/pipeline/consensus-vote.js';
import type { ConsensusPolicy } from '../../contracts/pipeline/pipeline-node.js';
import type { ConsensusVerdictName } from '../../contracts/workflow/consensus-verdict.js';
import type { ParticipantSettlement } from '../../contracts/workflow/participant-settlement.js';

export type ConsensusAdmission =
  | { readonly kind: 'accepted'; readonly vote: ConsensusVote }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'cancelled' };

export interface AcceptedVote {
  readonly participantId: string;
  readonly vote: ConsensusVoteLiteral;
  readonly executionId: string;
}

export interface ConsensusReductionState {
  readonly accepted: readonly AcceptedVote[];
  readonly failedIds: readonly string[];
  readonly invalidIds: readonly string[];
  readonly cancelledIds: readonly string[];
  readonly settledIds: readonly string[];
}

export type ConsensusReduction =
  | { readonly kind: 'pending'; readonly state: ConsensusReductionState }
  | {
      readonly kind: 'decided';
      readonly verdict: ConsensusVerdictName;
      readonly state: ConsensusReductionState;
    };

const voteLiterals: ReadonlySet<string> = new Set(['abstain', 'approve', 'reject']);

export const admitParticipantSettlement = (
  authoredIds: readonly string[],
  state: ConsensusReductionState,
  participantId: string,
  settlement: ParticipantSettlement,
): ConsensusAdmission => {
  if (!authoredIds.includes(participantId)) {
    return { kind: 'unknown' };
  }
  if (state.settledIds.includes(participantId)) {
    return { kind: 'duplicate' };
  }
  if (settlement.kind === 'voted') {
    if (settlement.vote.participantId !== participantId) {
      return { kind: 'invalid' };
    }
    return { kind: 'accepted', vote: settlement.vote };
  }
  if (settlement.kind === 'completedWithoutVote') {
    return { kind: 'invalid' };
  }
  if (settlement.kind === 'executionFailed') {
    return { kind: 'failed' };
  }
  if (settlement.kind === 'timedOut') {
    return { kind: 'timedOut' };
  }
  return { kind: 'cancelled' };
};

export const classifyCompletedVote = (
  participantId: string,
  outcome: string,
  vote: ConsensusVote | undefined,
): ParticipantSettlement => {
  if (
    vote !== undefined &&
    voteLiterals.has(outcome) &&
    vote.vote === outcome &&
    vote.participantId === participantId
  ) {
    return { kind: 'voted', vote };
  }
  return { kind: 'completedWithoutVote', outcome };
};

const spent = (state: ConsensusReductionState): ReadonlySet<string> =>
  new Set([
    ...state.accepted.map((entry) => entry.participantId),
    ...state.failedIds,
    ...state.invalidIds,
    ...state.cancelledIds,
  ]);

const remainingVoters = (authoredIds: readonly string[], state: ConsensusReductionState): number =>
  authoredIds.length - spent(state).size;

const counts = (state: ConsensusReductionState) => {
  let approve = 0;
  let reject = 0;
  let abstain = 0;
  for (const entry of state.accepted) {
    if (entry.vote === 'approve') {
      approve += 1;
    } else if (entry.vote === 'reject') {
      reject += 1;
    } else {
      abstain += 1;
    }
  }
  return { approve, reject, abstain };
};

const applyAdmission = (
  state: ConsensusReductionState,
  participantId: string,
  admission: ConsensusAdmission,
): ConsensusReductionState => {
  const settledIds = [...state.settledIds, participantId];
  if (admission.kind === 'accepted') {
    return {
      ...state,
      settledIds,
      accepted: [
        ...state.accepted,
        {
          participantId,
          vote: admission.vote.vote,
          executionId: admission.vote.executionId,
        },
      ],
    };
  }
  if (admission.kind === 'failed' || admission.kind === 'timedOut') {
    return { ...state, settledIds, failedIds: [...state.failedIds, participantId] };
  }
  if (admission.kind === 'invalid') {
    return { ...state, settledIds, invalidIds: [...state.invalidIds, participantId] };
  }
  if (admission.kind === 'cancelled') {
    return { ...state, settledIds, cancelledIds: [...state.cancelledIds, participantId] };
  }
  return state;
};

const remainingIds = (
  authoredIds: readonly string[],
  state: ConsensusReductionState,
): readonly string[] => {
  const used = spent(state);
  return authoredIds.filter((id) => !used.has(id));
};

const decideUnanimous = (
  authoredIds: readonly string[],
  state: ConsensusReductionState,
): ConsensusVerdictName | undefined => {
  const { approve, reject, abstain } = counts(state);
  if (state.failedIds.length > 0) {
    return 'failed';
  }
  if (reject > 0) {
    return 'rejected';
  }
  if (approve === authoredIds.length) {
    return 'approved';
  }
  if (remainingVoters(authoredIds, state) === 0) {
    return abstain > 0 || state.invalidIds.length > 0 ? 'insufficientQuorum' : 'failed';
  }
  return undefined;
};

const decideQuorum = (
  policy: Extract<ConsensusPolicy, { readonly kind: 'quorum' }>,
  authoredIds: readonly string[],
  state: ConsensusReductionState,
): ConsensusVerdictName | undefined => {
  if (state.failedIds.length > 0) {
    return 'failed';
  }
  if (remainingVoters(authoredIds, state) > 0) {
    return undefined;
  }
  const { approve, reject } = counts(state);
  const participation = approve + reject;
  if (participation < policy.count || approve === reject) {
    return 'insufficientQuorum';
  }
  return approve > reject ? 'approved' : 'rejected';
};

const decideThreshold = (
  policy: Extract<ConsensusPolicy, { readonly kind: 'threshold' }>,
  authoredIds: readonly string[],
  state: ConsensusReductionState,
): ConsensusVerdictName | undefined => {
  if (state.failedIds.length > 0) {
    return 'failed';
  }
  const { approve, reject } = counts(state);
  if (approve >= policy.approve) {
    return 'approved';
  }
  if (reject >= policy.reject) {
    return 'rejected';
  }
  const remaining = remainingVoters(authoredIds, state);
  if (approve + remaining < policy.approve && reject + remaining < policy.reject) {
    return 'insufficientQuorum';
  }
  return undefined;
};

const decidePolicy = (
  policy: ConsensusPolicy,
  authoredIds: readonly string[],
  state: ConsensusReductionState,
): ConsensusVerdictName | undefined => {
  if (policy.kind === 'unanimous') {
    return decideUnanimous(authoredIds, state);
  }
  if (policy.kind === 'quorum') {
    return decideQuorum(policy, authoredIds, state);
  }
  return decideThreshold(policy, authoredIds, state);
};

export const initialConsensusState = (): ConsensusReductionState => ({
  accepted: [],
  failedIds: [],
  invalidIds: [],
  cancelledIds: [],
  settledIds: [],
});

export const reduceConsensusSettlement = (
  policy: ConsensusPolicy,
  authoredIds: readonly string[],
  state: ConsensusReductionState,
  participantId: string,
  settlement: ParticipantSettlement,
  deadlineReached = false,
): ConsensusReduction => {
  const admission = admitParticipantSettlement(authoredIds, state, participantId, settlement);
  if (admission.kind === 'unknown' || admission.kind === 'duplicate') {
    return decide(policy, authoredIds, state, deadlineReached);
  }
  return decide(
    policy,
    authoredIds,
    applyAdmission(state, participantId, admission),
    deadlineReached,
  );
};

export const reduceConsensusDeadline = (
  policy: ConsensusPolicy,
  authoredIds: readonly string[],
  state: ConsensusReductionState,
): ConsensusReduction => decide(policy, authoredIds, state, true);

const decide = (
  policy: ConsensusPolicy,
  authoredIds: readonly string[],
  state: ConsensusReductionState,
  deadlineReached: boolean,
): ConsensusReduction => {
  const verdict = decidePolicy(policy, authoredIds, state);
  if (verdict !== undefined) {
    return { kind: 'decided', verdict, state };
  }
  if (deadlineReached) {
    return { kind: 'decided', verdict: 'timedOut', state };
  }
  return { kind: 'pending', state };
};

export const remainingParticipantIds = remainingIds;
