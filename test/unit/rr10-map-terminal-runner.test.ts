import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MapNode } from '../../src/contracts/pipeline/pipeline-node.js';
import {
  continued,
  execution,
  mapNode,
  mapRunnerHarness,
  terminal,
} from '../support/map/map-runner-harness.js';

const terminalPolicies: readonly { readonly name: string; readonly failure: MapNode['failure'] }[] =
  [
    { name: 'collect', failure: { kind: 'collect' } },
    { name: 'fail-fast cancel', failure: { kind: 'failFast', remaining: 'cancel' } },
    { name: 'fail-fast drain', failure: { kind: 'failFast', remaining: 'drain' } },
  ];

describe('RR-10 DBOS map terminal settlement', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lets a late active terminal supersede an already persisted drain decision', async () => {
    const subject = mapRunnerHarness(
      {
        a: continued(0, 'a', 'failed'),
        b: terminal(1, 'b'),
      },
      ['a', 'b', 'c'],
    );

    await expect(
      subject.runner.execute(
        execution(mapNode({ kind: 'failFast', remaining: 'drain' }), ['a', 'b', 'c']),
      ),
    ).resolves.toEqual({
      kind: 'terminal',
      result: { status: 'failed', outcome: 'event_budget_exceeded' },
    });
    expect(subject.decisions).toHaveLength(1);
    expect(subject.inputs.at(-1)).toMatchObject({ itemKey: 'c', disposition: 'settlementOnly' });
  });

  it.each(terminalPolicies)(
    'returns a terminal first settlement before a $name decision and drains the cancelled sibling',
    async ({ failure }) => {
      const lifecycle: string[] = [];
      const subject = mapRunnerHarness(
        { a: terminal(0, 'a'), b: continued(1, 'b') },
        ['a', 'b'],
        lifecycle,
      );

      await expect(
        subject.runner.execute(execution(mapNode(failure, 2), ['a', 'b', 'c'])),
      ).resolves.toEqual({
        kind: 'terminal',
        result: { status: 'failed', outcome: 'event_budget_exceeded' },
      });
      expect(subject.decisions).toEqual([]);
      expect(subject.inputs.map(({ itemKey }) => itemKey)).toEqual(['a', 'b']);
      expect(subject.cancelScopes).toHaveBeenCalledOnce();
      expect(lifecycle.indexOf('cancel')).toBeLessThan(lifecycle.indexOf('settle:b'));
    },
  );
});
