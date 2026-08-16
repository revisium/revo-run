import { describe, expect, it } from 'vitest';

import {
  decideGateAnswer,
  decideGateState,
  type HumanGateAuthoredPolicy,
} from '../../src/pipeline/human-gate/human-gate-policy.js';

const firstAnswerGate: HumanGateAuthoredPolicy = {
  answers: ['approved', 'rejected'],
  decision: { kind: 'firstAnswer' },
};

const eligibleGate: HumanGateAuthoredPolicy = {
  answers: ['approved', 'rejected'],
  decision: { kind: 'firstAnswer' },
  eligibleGroup: 'production-approvers',
};

const matchingGate: HumanGateAuthoredPolicy = {
  answers: ['approved', 'rejected'],
  decision: { kind: 'matchingAnswers', count: 2, onConflict: 'conflict' },
  eligibleGroup: 'production-approvers',
};

describe('decideGateAnswer', () => {
  it('accepts an answer inside the vocabulary from an eligible, new actor', () => {
    expect(
      decideGateAnswer(firstAnswerGate, [], {
        answer: 'approved',
        actorId: 'alice',
        actorGroups: [],
      }),
    ).toEqual({ kind: 'accepted' });
  });

  it('rejects an actor outside the authored eligible group', () => {
    expect(
      decideGateAnswer(eligibleGate, [], {
        answer: 'approved',
        actorId: 'mallory',
        actorGroups: ['developers'],
      }),
    ).toEqual({ kind: 'rejected', reason: 'actor_not_eligible' });
  });

  it('accepts an eligible actor whose asserted groups include the eligible group', () => {
    expect(
      decideGateAnswer(eligibleGate, [], {
        answer: 'approved',
        actorId: 'alice',
        actorGroups: ['production-approvers'],
      }),
    ).toEqual({ kind: 'accepted' });
  });

  it('treats every actor as eligible when no eligibleGroup is authored', () => {
    expect(
      decideGateAnswer(firstAnswerGate, [], {
        answer: 'approved',
        actorId: 'anyone',
        actorGroups: [],
      }),
    ).toEqual({ kind: 'accepted' });
  });

  it('rejects an answer outside the authored answers vocabulary', () => {
    expect(
      decideGateAnswer(firstAnswerGate, [], {
        answer: 'maybe',
        actorId: 'alice',
        actorGroups: [],
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid_gate_answer' });
  });

  it('rejects a second answer from an actor that already answered', () => {
    expect(
      decideGateAnswer(firstAnswerGate, [{ actorId: 'alice', answer: 'approved' }], {
        answer: 'rejected',
        actorId: 'alice',
        actorGroups: [],
      }),
    ).toEqual({ kind: 'rejected', reason: 'actor_already_answered' });
  });

  it('evaluates eligibility before vocabulary for an ineligible actor with an invalid answer', () => {
    expect(
      decideGateAnswer(eligibleGate, [], {
        answer: 'maybe',
        actorId: 'mallory',
        actorGroups: ['developers'],
      }),
    ).toEqual({ kind: 'rejected', reason: 'actor_not_eligible' });
  });
});

describe('decideGateState', () => {
  it('is pending with no accepted answers', () => {
    expect(decideGateState(firstAnswerGate, [])).toEqual({ kind: 'pending' });
  });

  it('resolves a firstAnswer gate on its first accepted answer', () => {
    expect(decideGateState(firstAnswerGate, [{ actorId: 'alice', answer: 'approved' }])).toEqual({
      kind: 'resolved',
      answer: 'approved',
    });
  });

  it('stays pending under matchingAnswers until the distinct-actor count is reached', () => {
    expect(decideGateState(matchingGate, [{ actorId: 'alice', answer: 'approved' }])).toEqual({
      kind: 'pending',
    });
  });

  it('resolves a matchingAnswers gate once distinct actors agree on the same answer', () => {
    expect(
      decideGateState(matchingGate, [
        { actorId: 'alice', answer: 'approved' },
        { actorId: 'bob', answer: 'approved' },
      ]),
    ).toEqual({ kind: 'resolved', answer: 'approved' });
  });

  it('resolves to conflict when distinct actors give different answers', () => {
    expect(
      decideGateState(matchingGate, [
        { actorId: 'alice', answer: 'approved' },
        { actorId: 'bob', answer: 'rejected' },
      ]),
    ).toEqual({ kind: 'conflict' });
  });

  it('refuses matchingAnswers onConflict wait instead of silently treating it as conflict', () => {
    expect(() =>
      decideGateState(
        {
          answers: ['approved', 'rejected'],
          decision: { kind: 'matchingAnswers', count: 2, onConflict: 'wait' },
        },
        [
          { actorId: 'alice', answer: 'approved' },
          { actorId: 'bob', answer: 'rejected' },
        ],
      ),
    ).toThrow('matchingAnswers onConflict wait is not implemented.');
  });
});
