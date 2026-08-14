import Schema from 'typebox/schema';
import { describe, expect, it } from 'vitest';

import {
  ParallelJoinObservationSchema,
  SkippedParallelBranchSchema,
} from '../../src/contracts/run/run-details.js';

const scopeId = `sc1_${'a'.repeat(43)}`;
const parentScopeId = `sc1_${'b'.repeat(43)}`;
const nodeInstanceId = `ni1_${'c'.repeat(43)}`;

const parallelJoin = {
  scopeId,
  nodeInstanceId,
  outcome: 'succeeded',
  remaining: 'cancel',
  observedBranchKeys: ['winner'],
  outputEligibleBranchKeys: ['winner'],
  skippedBranchKeys: ['pending'],
} as const;

const skippedBranch = {
  kind: 'parallelBranch',
  disposition: 'skipped',
  reason: 'join-decided',
  scopeId,
  parentScopeId,
  nodeInstanceId,
  branchKey: 'pending',
} as const;

const parallelJoinValidator = Schema.Compile(ParallelJoinObservationSchema);
const skippedBranchValidator = Schema.Compile(SkippedParallelBranchSchema);

describe('RR-08 public observation schema assurance', () => {
  it('accepts a RunParallelJoinDecision observation', () => {
    expect(parallelJoinValidator.Check(parallelJoin)).toBe(true);
  });

  it.each([
    {
      name: 'malformed nested branch-key collection',
      value: { ...parallelJoin, observedBranchKeys: ['winner', 1] },
    },
    {
      name: 'identifier grammar',
      value: { ...parallelJoin, observedBranchKeys: ['not valid'] },
    },
    { name: 'additional property', value: { ...parallelJoin, unexpected: true } },
  ])('rejects RunParallelJoinDecision observation: $name', ({ value }) => {
    expect(parallelJoinValidator.Check(value)).toBe(false);
  });

  it('accepts a RunSkippedParallelBranch observation', () => {
    expect(skippedBranchValidator.Check(skippedBranch)).toBe(true);
  });

  it.each([
    {
      name: 'malformed disposition',
      value: { ...skippedBranch, disposition: 'cancelled' },
    },
    { name: 'identifier grammar', value: { ...skippedBranch, branchKey: 'not valid' } },
    { name: 'scope identity grammar', value: { ...skippedBranch, scopeId: 'sc1_too-short' } },
    { name: 'additional property', value: { ...skippedBranch, unexpected: true } },
  ])('rejects RunSkippedParallelBranch observation: $name', ({ value }) => {
    expect(skippedBranchValidator.Check(value)).toBe(false);
  });
});
