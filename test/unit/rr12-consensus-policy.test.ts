import { describe, expect, it } from 'vitest';

import type { ConsensusVote } from '../../src/contracts/pipeline/consensus-vote.js';
import type { ParticipantSettlement } from '../../src/contracts/workflow/participant-settlement.js';
import {
  admitParticipantSettlement,
  classifyCompletedVote,
  initialConsensusState,
  reduceConsensusDeadline,
  reduceConsensusSettlement,
} from '../../src/pipeline/consensus/consensus-policy.js';

const vote = (
  participantId: string,
  value: ConsensusVote['vote'],
  executionId = `${participantId}-1`,
): ConsensusVote => ({
  nodePath: 'main/review',
  participantId,
  vote: value,
  executionId,
});

const voted = (participantId: string, value: ConsensusVote['vote']): ParticipantSettlement => ({
  kind: 'voted',
  vote: vote(participantId, value),
});

const reduce = (
  policy: Parameters<typeof reduceConsensusSettlement>[0],
  authored: readonly string[],
  settlements: readonly (readonly [string, ParticipantSettlement])[],
) =>
  settlements.reduce(
    (current, [id, settlement]) =>
      reduceConsensusSettlement(policy, authored, current.state, id, settlement),
    { kind: 'pending' as const, state: initialConsensusState() } as ReturnType<
      typeof reduceConsensusSettlement
    >,
  );

describe('RR-12 consensus policy', () => {
  it('accepts a completed approve vote and rejects a mismatched payload', () => {
    const accepted = classifyCompletedVote('a', 'approve', vote('a', 'approve'));
    const missing = classifyCompletedVote('a', 'approve', undefined);
    const mismatched = classifyCompletedVote('a', 'approve', vote('a', 'reject'));

    expect(accepted).toEqual({ kind: 'voted', vote: vote('a', 'approve') });
    expect(missing).toEqual({ kind: 'completedWithoutVote', outcome: 'approve' });
    expect(mismatched).toEqual({ kind: 'completedWithoutVote', outcome: 'approve' });
  });

  it('rejects unknown and duplicate participant settlements', () => {
    const authored = ['a', 'b'] as const;
    const first = reduceConsensusSettlement(
      { kind: 'unanimous' },
      authored,
      initialConsensusState(),
      'a',
      voted('a', 'approve'),
    );
    const duplicate = admitParticipantSettlement(authored, first.state, 'a', voted('a', 'reject'));
    const unknown = admitParticipantSettlement(authored, first.state, 'z', voted('z', 'approve'));

    expect(duplicate.kind).toBe('duplicate');
    expect(unknown.kind).toBe('unknown');
  });

  it('approves unanimous consensus only after every participant approves', () => {
    const decided = reduce(
      { kind: 'unanimous' },
      ['a', 'b'],
      [
        ['a', voted('a', 'approve')],
        ['b', voted('b', 'approve')],
      ],
    );

    expect(decided).toMatchObject({ kind: 'decided', verdict: 'approved' });
  });

  it('rejects unanimous consensus on the first reject', () => {
    const decided = reduceConsensusSettlement(
      { kind: 'unanimous' },
      ['a', 'b'],
      initialConsensusState(),
      'b',
      voted('b', 'reject'),
    );

    expect(decided).toMatchObject({ kind: 'decided', verdict: 'rejected' });
  });

  it('reports insufficient quorum when participation is below count', () => {
    const decided = reduce(
      { kind: 'quorum', count: 2 },
      ['a', 'b', 'c'],
      [
        ['a', voted('a', 'approve')],
        ['b', voted('b', 'abstain')],
        ['c', voted('c', 'abstain')],
      ],
    );

    expect(decided).toMatchObject({ kind: 'decided', verdict: 'insufficientQuorum' });
  });

  it('approves independent thresholds as soon as the approve count is met', () => {
    const decided = reduce(
      { kind: 'threshold', approve: 2, reject: 2 },
      ['a', 'b', 'c'],
      [
        ['a', voted('a', 'approve')],
        ['b', voted('b', 'approve')],
      ],
    );

    expect(decided).toMatchObject({ kind: 'decided', verdict: 'approved' });
    expect(decided.state.accepted).toHaveLength(2);
  });

  it('fails consensus when a participant execution fails without a vote', () => {
    const decided = reduceConsensusSettlement(
      { kind: 'unanimous' },
      ['a', 'b'],
      initialConsensusState(),
      'b',
      { kind: 'executionFailed' },
    );

    expect(decided).toMatchObject({ kind: 'decided', verdict: 'failed' });
  });

  it('times out only while the policy is still pending', () => {
    const pending = reduceConsensusSettlement(
      { kind: 'unanimous' },
      ['a', 'b'],
      initialConsensusState(),
      'a',
      voted('a', 'approve'),
    );
    const timedOut = reduceConsensusDeadline({ kind: 'unanimous' }, ['a', 'b'], pending.state);
    const afterReject = reduceConsensusSettlement(
      { kind: 'unanimous' },
      ['a', 'b'],
      initialConsensusState(),
      'a',
      voted('a', 'reject'),
    );
    const ignoredDeadline = reduceConsensusDeadline(
      { kind: 'unanimous' },
      ['a', 'b'],
      afterReject.state,
    );

    expect(timedOut).toMatchObject({ kind: 'decided', verdict: 'timedOut' });
    expect(ignoredDeadline).toMatchObject({ kind: 'decided', verdict: 'rejected' });
  });

  it('treats unanimous abstain after every vote as inconclusive', () => {
    const decided = reduce(
      { kind: 'unanimous' },
      ['a', 'b'],
      [
        ['a', voted('a', 'approve')],
        ['b', voted('b', 'abstain')],
      ],
    );

    expect(decided).toMatchObject({ kind: 'decided', verdict: 'insufficientQuorum' });
  });

  it('does not change a decided verdict when a later settlement arrives', () => {
    const first = reduceConsensusSettlement(
      { kind: 'threshold', approve: 2, reject: 2 },
      ['a', 'b', 'c'],
      initialConsensusState(),
      'a',
      voted('a', 'approve'),
    );
    const decided = reduceConsensusSettlement(
      { kind: 'threshold', approve: 2, reject: 2 },
      ['a', 'b', 'c'],
      first.state,
      'b',
      voted('b', 'approve'),
    );
    const afterLate = reduceConsensusSettlement(
      { kind: 'threshold', approve: 2, reject: 2 },
      ['a', 'b', 'c'],
      decided.state,
      'c',
      voted('c', 'reject'),
    );

    expect(decided).toMatchObject({ kind: 'decided', verdict: 'approved' });
    expect(afterLate).toMatchObject({ kind: 'decided', verdict: 'approved' });
  });
});
