import { describe, expect, it } from 'vitest';

import { mapRunCommandDecision } from '../../src/dbos/read-model/map-run-command-decision.js';
import { parseRunCommandDecision } from '../../src/validation/run-command-workflow.validator.js';

const commandId = 'cmd_00000000-0000-4000-8000-000000000000';
const attemptId = `at1_${'A'.repeat(43)}`;
const gateInstanceId = `ni1_${'A'.repeat(43)}`;

describe('RunDetails command decision mapping', () => {
  it('maps accepted adopted resolution without duplicating adopted output', () => {
    const decision = parseRunCommandDecision({
      commandId,
      commandKind: 'resolveUnknownOutcome',
      actorId: 'release-manager',
      decision: 'accepted',
      attemptId,
      resolutionKind: 'adoptSuccess',
      outcome: 'published',
    });

    expect(mapRunCommandDecision(decision)).toEqual({
      commandId,
      commandKind: 'resolveUnknownOutcome',
      actorId: 'release-manager',
      decision: 'accepted',
      targetAttemptId: attemptId,
      resolution: { kind: 'adoptSuccess', outcome: 'published' },
    });
    expect(JSON.stringify(mapRunCommandDecision(decision))).not.toContain('output');
  });

  it('maps an accepted answerGate decision with actor identity', () => {
    expect(
      mapRunCommandDecision(
        parseRunCommandDecision({
          commandId,
          commandKind: 'answerGate',
          gateInstanceId,
          actorId: 'alice',
          answer: 'approved',
          decision: 'accepted',
        }),
      ),
    ).toEqual({
      commandId,
      commandKind: 'answerGate',
      gateInstanceId,
      actorId: 'alice',
      answer: 'approved',
      decision: 'accepted',
    });
  });

  it('maps safe rejected command details', () => {
    expect(
      mapRunCommandDecision(
        parseRunCommandDecision({
          commandId,
          commandKind: 'resolveUnknownOutcome',
          actorId: 'operator',
          decision: 'rejected',
          reason: 'unknown_outcome_already_resolved',
          attemptId,
          resolutionKind: 'markFailed',
        }),
      ),
    ).toEqual({
      commandId,
      commandKind: 'resolveUnknownOutcome',
      actorId: 'operator',
      decision: 'rejected',
      reason: 'unknown_outcome_already_resolved',
      targetAttemptId: attemptId,
      resolution: { kind: 'markFailed' },
    });
  });

  it.each([
    { commandId, commandKind: 'cancelRun', actorId: 'operator', decision: 'accepted', extra: true },
    { commandId, commandKind: 'cancelRun', actorId: 'operator', decision: 'rejected' },
    {
      commandId,
      commandKind: 'resolveUnknownOutcome',
      actorId: 'operator',
      decision: 'accepted',
      resolutionKind: 'adoptSuccess',
      output: { secret: true },
    },
  ])('fails closed for malformed durable decision %#', (value) => {
    expect(() => parseRunCommandDecision(value)).toThrow('Run command decision is invalid.');
  });
});
