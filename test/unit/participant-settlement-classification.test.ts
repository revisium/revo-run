import { describe, expect, it } from 'vitest';

import { classifyNodeExecutionSettlement } from '../../src/pipeline/consensus/classify-participant-settlement.js';
import {
  reduceConsensusSettlement,
  initialConsensusState,
} from '../../src/pipeline/consensus/consensus-policy.js';

describe('participant settlement classification', () => {
  it('classifies a completed vote payload as voted', () => {
    expect(
      classifyNodeExecutionSettlement(
        'architecture',
        {
          kind: 'continued',
          outcome: 'approve',
          path: 'main/review/architecture',
          output: {
            vote: {
              kind: 'json',
              value: {
                nodePath: 'main/review',
                participantId: 'architecture',
                vote: 'approve',
                executionId: 'ex-1',
              },
            },
          },
        },
        {
          nodePath: 'main/review',
          participantId: 'architecture',
          vote: 'approve',
          executionId: 'ex-1',
        },
      ),
    ).toEqual({
      kind: 'voted',
      vote: {
        nodePath: 'main/review',
        participantId: 'architecture',
        vote: 'approve',
        executionId: 'ex-1',
      },
    });
  });

  it('classifies a completed non-vote outcome as completedWithoutVote', () => {
    expect(
      classifyNodeExecutionSettlement(
        'architecture',
        { kind: 'continued', outcome: 'completed', path: 'main/review/architecture' },
        undefined,
      ),
    ).toEqual({ kind: 'completedWithoutVote', outcome: 'completed' });
  });

  it('classifies a completed outcome failed without a vote as completedWithoutVote', () => {
    expect(
      classifyNodeExecutionSettlement(
        'architecture',
        { kind: 'continued', outcome: 'failed', path: 'main/review/architecture' },
        undefined,
        'completed',
      ),
    ).toEqual({ kind: 'completedWithoutVote', outcome: 'failed' });
  });

  it('classifies a failed effect as executionFailed', () => {
    expect(
      classifyNodeExecutionSettlement(
        'architecture',
        { kind: 'continued', outcome: 'failed', path: 'main/review/architecture' },
        undefined,
        'failed',
      ),
    ).toEqual({ kind: 'executionFailed' });
  });

  it('classifies terminal cancelled as cancelled', () => {
    expect(
      classifyNodeExecutionSettlement(
        'architecture',
        {
          kind: 'finished',
          provenance: 'terminal',
          result: { status: 'cancelled', outcome: 'cancelled' },
        },
        undefined,
      ),
    ).toEqual({ kind: 'cancelled' });
  });

  it('reports insufficient quorum when neither threshold remains reachable', () => {
    const decided = ['a', 'b', 'c'].reduce(
      (current, id) =>
        reduceConsensusSettlement(
          { kind: 'threshold', approve: 2, reject: 2 },
          ['a', 'b', 'c'],
          current.state,
          id,
          { kind: 'completedWithoutVote', outcome: 'completed' },
        ),
      { kind: 'pending' as const, state: initialConsensusState() } as ReturnType<
        typeof reduceConsensusSettlement
      >,
    );

    expect(decided).toMatchObject({ kind: 'decided', verdict: 'insufficientQuorum' });
  });
});
