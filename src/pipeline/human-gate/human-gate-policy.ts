/**
 * Pure human-gate policy: eligibility, answer vocabulary, duplicate-actor detection, and
 * firstAnswer / matchingAnswers distinct-actor threshold and conflict detection.
 *
 * This module is DBOS-free. It knows nothing about receipts, topics, steps, or durability; it
 * only decides what counts. Whether a gate is still open for answers at all is a registry
 * property owned by the caller (the coordinator), not this policy - see the human-gate
 * architecture notes, decision D-03.
 */

import type { HumanGateNode } from '../../contracts/pipeline/pipeline-node.js';

export type HumanGateDecisionPolicy = HumanGateNode['decision'];

export interface HumanGateAuthoredPolicy {
  readonly answers: readonly string[];
  readonly decision: HumanGateDecisionPolicy;
  readonly eligibleGroup?: string;
}

export interface HumanGateAcceptedAnswer {
  readonly actorId: string;
  readonly answer: string;
}

export interface HumanGateCandidateAnswer {
  readonly answer: string;
  readonly actorId: string;
  readonly actorGroups: readonly string[];
}

export type HumanGateAnswerRejectionReason =
  | 'actor_already_answered'
  | 'actor_not_eligible'
  | 'invalid_gate_answer';

export type HumanGateAnswerDecision =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason: HumanGateAnswerRejectionReason };

/**
 * Decides one candidate answer against the authored gate and the answers already accepted for
 * this gate instance. Order matches decision D-03: eligibility, then vocabulary, then duplicate
 * actor.
 */
export const decideGateAnswer = (
  gate: HumanGateAuthoredPolicy,
  accepted: readonly HumanGateAcceptedAnswer[],
  candidate: HumanGateCandidateAnswer,
): HumanGateAnswerDecision => {
  if (gate.eligibleGroup !== undefined && !candidate.actorGroups.includes(gate.eligibleGroup)) {
    return { kind: 'rejected', reason: 'actor_not_eligible' };
  }
  if (!gate.answers.includes(candidate.answer)) {
    return { kind: 'rejected', reason: 'invalid_gate_answer' };
  }
  if (accepted.some((entry) => entry.actorId === candidate.actorId)) {
    return { kind: 'rejected', reason: 'actor_already_answered' };
  }
  return { kind: 'accepted' };
};

export type HumanGateState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'resolved'; readonly answer: string }
  | { readonly kind: 'conflict' };

/**
 * Decides the gate's current resolution state from every answer accepted so far. Implements
 * firstAnswer and matchingAnswers with onConflict 'conflict' only; there is no 'wait' branch
 * because plan admission rejects that authored shape before a run exists.
 */
export const decideGateState = (
  gate: HumanGateAuthoredPolicy,
  accepted: readonly HumanGateAcceptedAnswer[],
): HumanGateState => {
  if (gate.decision.kind === 'firstAnswer') {
    const first = accepted[0];
    return first === undefined ? { kind: 'pending' } : { kind: 'resolved', answer: first.answer };
  }
  if (gate.decision.onConflict === 'wait') {
    throw new Error('matchingAnswers onConflict wait is not implemented.');
  }

  const distinctAnswerValues = new Set(accepted.map((entry) => entry.answer));
  if (distinctAnswerValues.size > 1) {
    return { kind: 'conflict' };
  }

  const requiredCount = gate.decision.count;
  const [onlyAnswer] = distinctAnswerValues;
  return accepted.length >= requiredCount && onlyAnswer !== undefined
    ? { kind: 'resolved', answer: onlyAnswer }
    : { kind: 'pending' };
};
