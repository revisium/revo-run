import { describe, expect, it } from 'vitest';

import type { ParallelJoinPolicy } from '../../src/contracts/pipeline/pipeline-node.js';
import {
  eligibleParallelResults,
  initialParallelJoinState,
  settleParallelBranch,
} from '../../src/pipeline/parallel/parallel-join-reducer.js';

const result = (key: string, outcome: string) => ({ key, outcome, outputs: [] });

const thresholdPolicy: ParallelJoinPolicy = {
  kind: 'threshold',
  count: 2,
  successfulOutcomes: ['completed'],
  remaining: 'cancel',
};

const thresholdCases: readonly (readonly [readonly string[], 'succeeded'])[] = [
  [['b', 'a'], 'succeeded'],
  [['c', 'a'], 'succeeded'],
  [['a', 'c'], 'succeeded'],
];

interface IncrementalJoinCase {
  readonly policy: ParallelJoinPolicy;
  readonly outcomes: readonly string[];
  readonly expected: 'succeeded' | 'failed';
}

const incrementalJoinCases: readonly IncrementalJoinCase[] = [
  {
    policy: { kind: 'all', successfulOutcomes: ['completed'], remaining: 'drain' },
    outcomes: ['failed'],
    expected: 'failed',
  },
  {
    policy: { kind: 'any', successfulOutcomes: ['completed'], remaining: 'drain' },
    outcomes: ['completed'],
    expected: 'succeeded',
  },
];

const reduce = (policy: ParallelJoinPolicy, settlements: readonly ReturnType<typeof result>[]) =>
  settlements.reduce(
    (state, settlement) => settleParallelBranch(policy, ['a', 'b', 'c'], state, settlement),
    initialParallelJoinState(),
  );

describe('RR-08 parallel join reducer', () => {
  it.each(thresholdCases)(
    'freezes a threshold decision at the first decisive prefix %j',
    (keys, outcome) => {
      const decided = reduce(
        thresholdPolicy,
        keys.map((key) => result(key, 'completed')),
      );
      const observed = decided.decision;
      const lateKey = ['a', 'b', 'c'].find((key) => !keys.includes(key));
      if (lateKey === undefined) {
        throw new Error('Test vector has no remaining branch.');
      }
      const afterLateFailure = settleParallelBranch(
        thresholdPolicy,
        ['a', 'b', 'c'],
        decided,
        result(lateKey, 'failed'),
      );

      expect(observed).toEqual({
        outcome,
        observedBranchKeys: keys,
        outputEligibleBranchKeys: ['a', 'b', 'c'].filter((key) => keys.includes(key)),
      });
      expect(afterLateFailure.decision).toBe(observed);
    },
  );

  it('fails when a threshold becomes impossible and excludes later output', () => {
    const decided = reduce(thresholdPolicy, [result('b', 'failed'), result('a', 'failed')]);
    const afterLateSuccess = settleParallelBranch(
      thresholdPolicy,
      ['a', 'b', 'c'],
      decided,
      result('c', 'completed'),
    );

    expect(decided.decision).toEqual({
      outcome: 'failed',
      observedBranchKeys: ['b', 'a'],
      outputEligibleBranchKeys: ['a', 'b'],
    });
    expect(eligibleParallelResults(afterLateSuccess).map(({ key }) => key)).toEqual(['a', 'b']);
  });

  it.each(incrementalJoinCases)(
    'decides $policy.kind joins incrementally',
    ({ policy, outcomes, expected }) => {
      const state = reduce(
        policy,
        outcomes.map((outcome, index) => result(['a', 'b', 'c'][index] ?? 'a', outcome)),
      );
      expect(state.decision?.outcome).toBe(expected);
    },
  );
});
