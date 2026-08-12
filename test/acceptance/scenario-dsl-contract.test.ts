import { describe, expect, it } from 'vitest';

import type { RunScenario, ScenarioCommandRejectionReason } from '../dsl/run-scenario.js';
import {
  advanceLogicalTime,
  advanceTime,
  expectCommandAccepted,
  scenarioTimeoutMs,
} from '../dsl/run-scenario.js';
import { plannedPipelineScenarios } from './capability-matrix.js';
import { implementedCapabilities } from './scenario-readiness.js';

const scenarioByIntentId = (intentId: string): RunScenario => {
  const scenario = plannedPipelineScenarios.find((candidate) => candidate.intentId === intentId);
  if (scenario === undefined) {
    throw new Error(`Scenario ${intentId} is missing.`);
  }
  return scenario;
};

describe('acceptance scenario DSL', () => {
  it('requires implemented DBOS-safe time advancement in both directions', () => {
    expect(implementedCapabilities).toContain('dbosSafeTimeAdvancement');
    for (const scenario of plannedPipelineScenarios) {
      const advancesTime = scenario.steps.some(({ kind }) => kind === 'advanceTime');
      const requiresSafeTime = scenario.requiredCapabilities.includes('dbosSafeTimeAdvancement');

      expect({ intentId: scenario.intentId, requiresSafeTime }).toEqual({
        intentId: scenario.intentId,
        requiresSafeTime: advancesTime,
      });
    }
  });

  it('defines positive cumulative logical time and preserves it explicitly on restart', () => {
    expect(() => advanceTime(0)).toThrow('Time advancement must be positive.');
    expect(() => advanceTime(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      'Time advancement must be a safe integer.',
    );

    const restartDelayScenario = scenarioByIntentId('rr-075');
    expect(restartDelayScenario.steps.map(({ kind }) => kind)).toEqual([
      'startRun',
      'advanceTime',
      'crashManager',
      'restartManager',
      'advanceTime',
      'expectRunStatus',
    ]);

    let elapsedTimeMs = 0;
    const elapsedAtRestart: number[] = [];
    for (const step of restartDelayScenario.steps) {
      if (step.kind === 'advanceTime') {
        elapsedTimeMs = advanceLogicalTime(elapsedTimeMs, step.durationMs);
      } else if (step.kind === 'restartManager') {
        elapsedAtRestart.push(elapsedTimeMs);
      }
    }

    expect(elapsedAtRestart).toEqual([30_000]);
    expect(elapsedTimeMs).toBe(60_000);
    expect(scenarioTimeoutMs(restartDelayScenario.steps)).toBe(90_000);
  });

  it('binds command-result expectations bidirectionally to command rejection', () => {
    const allowedReasons = new Set<ScenarioCommandRejectionReason>([
      'actor_already_answered',
      'actor_not_eligible',
      'gate_already_resolved',
      'invalid_gate_answer',
      'run_already_terminal',
    ]);

    expect(expectCommandAccepted('command-accepted-1')).toEqual({
      kind: 'expectCommandResult',
      result: { status: 'accepted', commandId: 'command-accepted-1' },
    });
    for (const scenario of plannedPipelineScenarios) {
      const commandIds = scenario.steps.flatMap((step) =>
        step.kind === 'answerHumanGate' ||
        step.kind === 'cancelRun' ||
        step.kind === 'resolveUnknownOutcome'
          ? [step.commandId]
          : [],
      );
      const commandResults = scenario.steps.flatMap((step) =>
        step.kind === 'expectCommandResult' ? [step.result] : [],
      );
      const requiresCommandRejection = scenario.requiredCapabilities.includes('commandRejection');

      expect(commandResults.length > 0).toBe(requiresCommandRejection);
      for (const result of commandResults) {
        expect(commandIds).toContain(result.commandId);
      }
      expect(
        commandResults.every(
          (result) => result.status === 'accepted' || allowedReasons.has(result.reason),
        ),
      ).toBe(true);
    }
  });

  it('makes terminal cancellation rejection primary and its event secondary', () => {
    const terminalCancellation = scenarioByIntentId('rr-020');
    const resultIndex = terminalCancellation.steps.findIndex(
      ({ kind }) => kind === 'expectCommandResult',
    );
    const eventIndex = terminalCancellation.steps.findIndex(
      (step) => step.kind === 'expectEvent' && step.event.type === 'run.cancellationRejected',
    );

    expect(terminalCancellation.steps[resultIndex]).toEqual({
      kind: 'expectCommandResult',
      result: {
        status: 'rejected',
        commandId: 'cancel-completed-1',
        reason: 'run_already_terminal',
      },
    });
    expect(eventIndex).toBeGreaterThan(resultIndex);
  });

  it('records normalized consensus votes without inferring a vote from failure', () => {
    expect(scenarioByIntentId('rr-040').requiredCapabilities.includes('commandRejection')).toBe(
      false,
    );
    expect(
      scenarioByIntentId('rr-041').steps.some(
        ({ kind }) => kind === 'completeConsensusParticipant',
      ),
    ).toBe(false);
    expect(
      plannedPipelineScenarios
        .flatMap(({ steps }) => steps)
        .every(
          (step) =>
            step.kind !== 'completeConsensusParticipant' ||
            (step.vote.nodePath.length > 0 &&
              step.vote.participantId.length > 0 &&
              step.vote.executionId.length > 0 &&
              ['approve', 'reject', 'abstain'].includes(step.vote.vote)),
        ),
    ).toBe(true);
  });
});
