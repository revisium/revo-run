import type { RunCommandDetails } from '../../contracts/run/run-details.js';
import type { RunCommandDecision } from '../../contracts/workflow/run-command-workflow.js';

const decisionResult = (decision: RunCommandDecision) =>
  decision.decision === 'accepted'
    ? ({ decision: 'accepted' } as const)
    : ({ decision: 'rejected', reason: decision.reason } as const);

export const mapRunCommandDecision = (decision: RunCommandDecision): RunCommandDetails => {
  const result = decisionResult(decision);
  if (decision.commandKind === 'answerGate') {
    return {
      commandId: decision.commandId,
      commandKind: 'answerGate',
      gateInstanceId: decision.gateInstanceId,
      actorId: decision.actorId,
      answer: decision.answer,
      ...result,
    };
  }
  if (decision.commandKind === 'cancelRun') {
    return {
      commandId: decision.commandId,
      commandKind: 'cancelRun',
      actorId: decision.actorId,
      ...result,
    };
  }
  return {
    commandId: decision.commandId,
    commandKind: 'resolveUnknownOutcome',
    actorId: decision.actorId,
    targetAttemptId: decision.attemptId,
    ...result,
    resolution: {
      kind: decision.resolutionKind,
      ...(decision.resolutionKind === 'adoptSuccess' ? { outcome: decision.outcome } : {}),
    },
  };
};
