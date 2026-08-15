import { describe, expect, it } from 'vitest';

import type { MapNode } from '../../src/contracts/pipeline/pipeline-node.js';
import type { MapItemResult } from '../../src/contracts/workflow/map-item-result.js';
import type { PreparedMapItem } from '../../src/pipeline/map/map-item-runner.js';
import {
  completeMapSettlement,
  initialMapAdmissionPlan,
  initialMapSettlementState,
  reduceMapSettlement,
  type MapSettlementContext,
} from '../../src/pipeline/map/map-settlement-reducer.js';

const scopeId = `sc1_${'a'.repeat(43)}`;
const nodeInstanceId = `ni1_${'b'.repeat(43)}`;
const item = (sourceIndex: number, itemKey: string): PreparedMapItem => ({
  sourceIndex,
  itemKey,
  value: { key: itemKey },
});
const firstItem = item(0, 'a');
const secondItem = item(1, 'b');
const thirdItem = item(2, 'c');
const items = [firstItem, secondItem, thirdItem];
const context = (failure: MapNode['failure']): MapSettlementContext => ({
  failure,
  items,
  scopeId,
  nodeInstanceId,
});
const continued = (settled: PreparedMapItem, outcome = 'completed'): MapItemResult => ({
  kind: 'continued',
  sourceIndex: settled.sourceIndex,
  itemKey: settled.itemKey,
  outcome,
});
const terminal = (settled: PreparedMapItem): MapItemResult => ({
  kind: 'terminal',
  sourceIndex: settled.sourceIndex,
  itemKey: settled.itemKey,
  result: { status: 'failed', outcome: 'event_budget_exceeded' },
});

describe('RR-10 map settlement reducer', () => {
  it.each([
    { name: 'collect', failure: { kind: 'collect' } as const },
    {
      name: 'fail-fast cancel',
      failure: { kind: 'failFast', remaining: 'cancel' } as const,
    },
    {
      name: 'fail-fast drain',
      failure: { kind: 'failFast', remaining: 'drain' } as const,
    },
  ])(
    'returns the first terminal result before a $name decision without admitting queued work',
    ({ failure }) => {
      const policy = context(failure);
      const afterTerminal = reduceMapSettlement(
        policy,
        { activeCount: 1, admitted: items.slice(0, 2), pending: items.slice(2) },
        initialMapSettlementState(),
        { item: firstItem, disposition: 'execute', result: terminal(firstItem) },
      );

      expect(afterTerminal.state).toMatchObject({
        terminal: { status: 'failed', outcome: 'event_budget_exceeded' },
      });
      expect(afterTerminal.state.decision).toBeUndefined();
      expect(afterTerminal.actions).toEqual([
        { kind: 'discardPending' },
        { kind: 'cancelActive', nodeInstanceId },
      ]);
      expect(afterTerminal.actions).not.toContainEqual(
        expect.objectContaining({ kind: 'admitNext' }),
      );

      const afterSibling = reduceMapSettlement(
        policy,
        { activeCount: 0, admitted: items.slice(0, 2), pending: [] },
        afterTerminal.state,
        { item: secondItem, disposition: 'discarded', result: continued(secondItem) },
      );
      const completion = completeMapSettlement(policy, afterSibling.state, {
        activeCount: 0,
        admitted: items.slice(0, 2),
        pending: [],
      });

      expect(afterSibling.actions).toEqual([]);
      expect(completion.actions).toEqual([]);
      expect(completion.result).toEqual({
        kind: 'terminal',
        result: { status: 'failed', outcome: 'event_budget_exceeded' },
      });
    },
  );

  it('builds and persists a fail-fast cancel decision before discarding or cancelling work', () => {
    const policy = context({ kind: 'failFast', remaining: 'cancel' });
    const transition = reduceMapSettlement(
      policy,
      { activeCount: 1, admitted: items.slice(0, 2), pending: items.slice(2) },
      initialMapSettlementState(),
      { item: firstItem, disposition: 'execute', result: continued(firstItem, 'failed') },
    );

    expect(transition.state.decision).toMatchObject({
      control: 'failureDecided',
      decisiveItemKey: 'a',
      summaryEligibleItemKeys: ['a'],
      admitted: [
        { sourceIndex: 0, itemKey: 'a' },
        { sourceIndex: 1, itemKey: 'b' },
      ],
      remaining: [{ sourceIndex: 2, itemKey: 'c', disposition: 'cancel' }],
    });
    expect(transition.actions).toEqual([
      { kind: 'persistControlDecision', decision: transition.state.decision },
      { kind: 'discardPending' },
      { kind: 'cancelActive', nodeInstanceId },
    ]);
  });

  it('admits drain-only scopes after one persisted failure decision', () => {
    const policy = context({ kind: 'failFast', remaining: 'drain' });
    const decided = reduceMapSettlement(
      policy,
      { activeCount: 1, admitted: items.slice(0, 2), pending: items.slice(2) },
      initialMapSettlementState(),
      { item: firstItem, disposition: 'execute', result: continued(firstItem, 'failed') },
    );

    expect(decided.actions.map(({ kind }) => kind)).toEqual([
      'persistControlDecision',
      'admitNext',
    ]);
    expect(decided.actions.at(-1)).toEqual({
      kind: 'admitNext',
      disposition: 'settlementOnly',
    });

    const afterActive = reduceMapSettlement(
      policy,
      { activeCount: 1, admitted: items, pending: [] },
      decided.state,
      { item: secondItem, disposition: 'execute', result: continued(secondItem) },
    );
    expect(afterActive.actions).toEqual([]);
    expect(
      afterActive.actions.filter(({ kind }) => kind === 'persistControlDecision'),
    ).toHaveLength(0);
  });

  it('completes collect maps from source-ordered eligible results and one all-settled intent', () => {
    const policy = context({ kind: 'collect' });
    const first = reduceMapSettlement(
      policy,
      { activeCount: 1, admitted: items.slice(0, 2), pending: items.slice(2) },
      initialMapSettlementState(),
      { item: secondItem, disposition: 'execute', result: continued(secondItem) },
    );
    const second = reduceMapSettlement(
      policy,
      { activeCount: 1, admitted: items, pending: [] },
      first.state,
      { item: firstItem, disposition: 'execute', result: continued(firstItem, 'failed') },
    );
    const third = reduceMapSettlement(
      policy,
      { activeCount: 0, admitted: items, pending: [] },
      second.state,
      { item: thirdItem, disposition: 'execute', result: continued(thirdItem) },
    );
    const completion = completeMapSettlement(policy, third.state, {
      activeCount: 0,
      admitted: items,
      pending: [],
    });

    expect(completion.actions).toEqual([
      { kind: 'persistControlDecision', decision: completion.state.decision },
    ]);
    expect(completion.result).toMatchObject({
      kind: 'continued',
      outcome: 'completedWithErrors',
      output: {
        summary: {
          value: {
            totalItems: 3,
            completedItems: 2,
            failedItems: 1,
            failures: [{ itemKey: 'a', outcome: 'failed' }],
          },
        },
      },
    });

    const replayedCompletion = completeMapSettlement(policy, completion.state, {
      activeCount: 0,
      admitted: items,
      pending: [],
    });
    expect(replayedCompletion.actions).toEqual([]);
    expect(replayedCompletion.result).toEqual(completion.result);
  });

  it('plans only the map-local initial admission window', () => {
    expect(initialMapAdmissionPlan(2, 3)).toEqual([
      { kind: 'admitNext', disposition: 'execute' },
      { kind: 'admitNext', disposition: 'execute' },
    ]);
  });
});
