import { describe, expect, it } from 'vitest';

import type { ParallelJoinPolicy } from '../../src/contracts/pipeline/pipeline-node.js';
import type { ParallelBranchResult } from '../../src/contracts/workflow/parallel-branch-result.js';
import {
  completeParallelSettlement,
  initialParallelAdmissionPlan,
  initialParallelSettlementState,
  reduceParallelSettlement,
  type ParallelSettlementContext,
} from '../../src/pipeline/parallel/parallel-settlement-reducer.js';

const scopeId = `sc1_${'a'.repeat(43)}`;
const nodeInstanceId = `ni1_${'b'.repeat(43)}`;

const join = (remaining: 'cancel' | 'drain'): ParallelJoinPolicy => ({
  kind: 'any',
  successfulOutcomes: ['completed'],
  remaining,
});

const context = (remaining: 'cancel' | 'drain'): ParallelSettlementContext => ({
  join: join(remaining),
  branchKeys: ['a', 'b', 'c'],
  scopeId,
  nodeInstanceId,
});

const continued = (key: string, outcome = 'completed'): ParallelBranchResult => ({
  kind: 'continued',
  key,
  outcome,
  outputs: [],
});

const terminal = (key: string, outcome = 'event_budget_exceeded'): ParallelBranchResult => ({
  kind: 'terminal',
  key,
  result: { status: 'failed', outcome },
});

const snapshot = (pending: readonly string[], activeCount: number) => ({
  pendingBranchKeys: pending,
  activeCount,
});

describe('parallel settlement reducer', () => {
  it.each(['cancel', 'drain'] as const)(
    'returns a terminal before a %s decision without admitting queued work',
    (remaining) => {
      const afterTerminal = reduceParallelSettlement(
        context(remaining),
        snapshot(['b', 'c'], 1),
        initialParallelSettlementState(),
        { disposition: 'execute', result: terminal('a', 'cancelled') },
      );

      expect(afterTerminal.state.terminal).toEqual({ status: 'failed', outcome: 'cancelled' });
      expect(afterTerminal.state.decision).toBeUndefined();
      expect(afterTerminal.actions).toEqual(
        remaining === 'cancel'
          ? [{ kind: 'discardPending' }, { kind: 'cancelActive', nodeInstanceId }]
          : [{ kind: 'discardPending' }],
      );
      expect(afterTerminal.actions).not.toContainEqual(
        expect.objectContaining({ kind: 'admitNext' }),
      );
    },
  );

  it('keeps a persisted decision when an event-budget terminal arrives later', () => {
    const decided = reduceParallelSettlement(
      context('cancel'),
      snapshot(['c'], 1),
      initialParallelSettlementState(),
      { disposition: 'execute', result: continued('a') },
    );
    expect(decided.state.decision).toBeDefined();

    const afterBudget = reduceParallelSettlement(
      context('cancel'),
      snapshot([], 0),
      decided.state,
      { disposition: 'execute', result: terminal('b') },
    );

    expect(afterBudget.state.terminal).toEqual({
      status: 'failed',
      outcome: 'event_budget_exceeded',
    });
    expect(afterBudget.state.decision).toEqual(decided.state.decision);
    expect(afterBudget.actions).not.toContainEqual(
      expect.objectContaining({ kind: 'persistJoinDecision' }),
    );
  });

  it('persists then cancels leftover work on a decisive cancel join', () => {
    const afterDecision = reduceParallelSettlement(
      context('cancel'),
      snapshot(['b', 'c'], 1),
      initialParallelSettlementState(),
      { disposition: 'execute', result: continued('a') },
    );

    expect(afterDecision.actions[0]).toMatchObject({
      kind: 'persistJoinDecision',
      decision: { skippedBranchKeys: ['b', 'c'] },
    });
    expect(afterDecision.actions.slice(1)).toEqual([
      { kind: 'discardPending' },
      { kind: 'cancelActive', nodeInstanceId },
    ]);
  });

  it('lets an active terminal override an early drain decision without admitting leftover work', () => {
    const decided = reduceParallelSettlement(
      context('drain'),
      snapshot(['b', 'c'], 1),
      initialParallelSettlementState(),
      { disposition: 'execute', result: continued('a') },
    );
    expect(decided.state.decision).toBeDefined();

    const afterTerminal = reduceParallelSettlement(
      context('drain'),
      snapshot(['c'], 1),
      decided.state,
      { disposition: 'execute', result: terminal('b') },
    );

    expect(afterTerminal.state.terminal).toEqual({
      status: 'failed',
      outcome: 'event_budget_exceeded',
    });
    expect(afterTerminal.state.decision).toEqual(decided.state.decision);
    expect(afterTerminal.actions).toEqual([{ kind: 'discardPending' }]);
  });

  it('persists then drains remaining work on a decisive drain join', () => {
    const afterDecision = reduceParallelSettlement(
      context('drain'),
      snapshot(['b', 'c'], 1),
      initialParallelSettlementState(),
      { disposition: 'execute', result: continued('a') },
    );

    expect(afterDecision.actions[0]).toMatchObject({
      kind: 'persistJoinDecision',
      decision: { skippedBranchKeys: [] },
    });
    expect(afterDecision.actions.slice(1)).toEqual([
      { kind: 'admitNext', disposition: 'settlementOnly' },
    ]);
  });

  it('ignores a discarded settlement in a terminal cancel state', () => {
    const afterTerminal = reduceParallelSettlement(
      context('cancel'),
      snapshot([], 1),
      { ...initialParallelSettlementState(), terminal: { status: 'failed', outcome: 'cancelled' } },
      { disposition: 'discarded', result: continued('b') },
    );

    expect(afterTerminal.actions).toEqual([]);
    expect(afterTerminal.state.terminal).toEqual({ status: 'failed', outcome: 'cancelled' });
  });

  it('admits the initial execute window', () => {
    expect(initialParallelAdmissionPlan(2, 4)).toEqual([
      { kind: 'admitNext', disposition: 'execute' },
      { kind: 'admitNext', disposition: 'execute' },
    ]);
  });

  it('throws when completion has neither a terminal nor a join decision', () => {
    expect(() => completeParallelSettlement(initialParallelSettlementState())).toThrow(
      'Parallel branches settled without a join decision.',
    );
  });
});
