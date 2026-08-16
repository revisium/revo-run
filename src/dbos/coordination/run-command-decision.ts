import type { RunCommandRequestMetadata } from '../../contracts/run/run-command-metadata.js';
import type {
  RunCommandReceipt,
  RunCommandRejectionReason,
} from '../../contracts/run/run-command.js';
import type { RunEventDraft } from '../../contracts/run/run-event.js';
import type {
  CommandDispatchWorkflowInput,
  RunCommandDecision,
} from '../../contracts/workflow/run-command-workflow.js';
import {
  decideGateAnswer,
  type HumanGateAcceptedAnswer,
  type HumanGateAuthoredPolicy,
} from '../../pipeline/human-gate/human-gate-policy.js';
import type { WaitingUnknownOutcome } from './unknown-outcome-registry.js';

export interface OpenGateDecisionInput {
  readonly policy: HumanGateAuthoredPolicy;
  readonly accepted: readonly HumanGateAcceptedAnswer[];
}

interface RunCommandDecisionState {
  readonly cancellationRequested: boolean;
  readonly executions: number;
  readonly maximumExecutions: number;
  readonly waiting: WaitingUnknownOutcome | undefined;
  readonly gate: OpenGateDecisionInput | undefined;
}

export const prospectiveRunCommandReceipt = (
  input: CommandDispatchWorkflowInput,
  state: RunCommandDecisionState,
): RunCommandReceipt => {
  const rejected = (
    reason: RunCommandRejectionReason,
  ): Extract<RunCommandReceipt, { readonly status: 'rejected' }> => ({
    status: 'rejected',
    commandId: input.commandId,
    reason,
  });
  if (input.command.kind === 'answerGate') {
    if (state.gate === undefined) {
      return rejected('gate_already_resolved');
    }
    const decision = decideGateAnswer(state.gate.policy, state.gate.accepted, {
      answer: input.command.input.answer,
      actorId: input.command.input.actorId,
      actorGroups: input.command.input.actorGroups,
    });
    return decision.kind === 'accepted'
      ? { status: 'accepted', commandId: input.commandId }
      : rejected(decision.reason);
  }
  if (input.command.kind === 'cancelRun') {
    return { status: 'accepted', commandId: input.commandId };
  }
  if (state.cancellationRequested) {
    return rejected('run_cancellation_requested');
  }
  if (state.waiting === undefined) {
    return rejected('unknown_outcome_not_pending');
  }
  if (state.waiting.resolved) {
    return rejected('unknown_outcome_already_resolved');
  }
  if (input.command.input.resolution.kind !== 'retry') {
    return { status: 'accepted', commandId: input.commandId };
  }
  const retry = state.waiting.retry;
  return retry !== undefined &&
    state.waiting.request.attemptOrdinal < retry.maximumAttempts &&
    state.executions < state.maximumExecutions
    ? { status: 'accepted', commandId: input.commandId }
    : rejected('unknown_outcome_retry_not_permitted');
};

const commandMetadata = (input: CommandDispatchWorkflowInput): RunCommandRequestMetadata => {
  const command = input.command;
  if (command.kind === 'answerGate') {
    return {
      commandId: input.commandId,
      commandKind: 'answerGate',
      gateInstanceId: command.input.gateInstanceId,
      actorId: command.input.actorId,
      answer: command.input.answer,
    };
  }
  if (command.kind === 'cancelRun') {
    return {
      commandId: input.commandId,
      commandKind: 'cancelRun',
      actorId: command.input.actorId,
    };
  }
  switch (command.input.resolution.kind) {
    case 'adoptSuccess':
      return {
        commandId: input.commandId,
        commandKind: 'resolveUnknownOutcome',
        actorId: command.input.actorId,
        attemptId: command.input.attemptId,
        resolutionKind: 'adoptSuccess',
        outcome: command.input.resolution.outcome,
      };
    case 'markFailed':
      return {
        commandId: input.commandId,
        commandKind: 'resolveUnknownOutcome',
        actorId: command.input.actorId,
        attemptId: command.input.attemptId,
        resolutionKind: 'markFailed',
      };
    case 'retry':
      return {
        commandId: input.commandId,
        commandKind: 'resolveUnknownOutcome',
        actorId: command.input.actorId,
        attemptId: command.input.attemptId,
        resolutionKind: 'retry',
      };
  }
  command.input.resolution satisfies never;
  throw new Error('Unknown-outcome resolution metadata is unsupported.');
};

type RunCommandEventDraft = Extract<
  RunEventDraft,
  { readonly type: 'runCommand.accepted' | 'runCommand.rejected' }
>;

const answerGateEvent = (
  metadata: Extract<RunCommandRequestMetadata, { readonly commandKind: 'answerGate' }>,
  receipt: RunCommandReceipt,
): RunCommandEventDraft => {
  if (receipt.status === 'accepted') {
    return { type: 'runCommand.accepted', data: metadata };
  }
  if (
    receipt.reason === 'actor_already_answered' ||
    receipt.reason === 'actor_not_eligible' ||
    receipt.reason === 'gate_already_resolved' ||
    receipt.reason === 'invalid_gate_answer'
  ) {
    return {
      type: 'runCommand.rejected',
      data: { ...metadata, reason: receipt.reason },
    };
  }
  throw new Error('An answer-gate command rejection is inconsistent with the gate vocabulary.');
};

export const createRunCommandEvent = (
  input: CommandDispatchWorkflowInput,
  receipt: RunCommandReceipt,
): RunCommandEventDraft => {
  const metadata = commandMetadata(input);
  switch (metadata.commandKind) {
    case 'cancelRun':
      if (receipt.status !== 'accepted') {
        throw new Error('A live cancel command must be accepted.');
      }
      return { type: 'runCommand.accepted', data: metadata };
    case 'answerGate':
      return answerGateEvent(metadata, receipt);
    case 'resolveUnknownOutcome':
      if (receipt.status === 'accepted') {
        return { type: 'runCommand.accepted', data: metadata };
      }
      switch (metadata.resolutionKind) {
        case 'adoptSuccess':
        case 'markFailed':
          if (
            receipt.reason === 'run_cancellation_requested' ||
            receipt.reason === 'unknown_outcome_not_pending' ||
            receipt.reason === 'unknown_outcome_already_resolved'
          ) {
            return {
              type: 'runCommand.rejected',
              data: { ...metadata, reason: receipt.reason },
            };
          }
          break;
        case 'retry':
          if (
            receipt.reason === 'run_cancellation_requested' ||
            receipt.reason === 'unknown_outcome_not_pending' ||
            receipt.reason === 'unknown_outcome_already_resolved' ||
            receipt.reason === 'unknown_outcome_retry_not_permitted'
          ) {
            return {
              type: 'runCommand.rejected',
              data: { ...metadata, reason: receipt.reason },
            };
          }
          break;
      }
      throw new Error('Unknown-outcome command rejection is inconsistent with its resolution.');
  }
  metadata satisfies never;
  throw new Error('Run command metadata is unsupported.');
};

export const createRunCommandDecision = (
  input: CommandDispatchWorkflowInput,
  receipt: RunCommandReceipt,
): RunCommandDecision => {
  const event = createRunCommandEvent(input, receipt);
  if (event.type === 'runCommand.accepted') {
    return { ...event.data, decision: 'accepted' };
  }
  return { ...event.data, decision: 'rejected' };
};
