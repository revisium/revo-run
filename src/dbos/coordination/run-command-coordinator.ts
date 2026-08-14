import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunCommandReceipt } from '../../contracts/run/run-command.js';
import type { RunEventDraft } from '../../contracts/run/run-event.js';
import type {
  CommandDispatchWorkflowInput,
  CommandDispatchWorkflowResult,
  RunCommandDecision,
  UnknownResolutionDirective,
} from '../../contracts/workflow/run-command-workflow.js';
import { unknownOutcomeResolvedFailureCode } from '../../contracts/workflow/run-command-workflow.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import { createAttemptId } from '../../pipeline/identity/execution-identity.js';
import { parseRunCommandDecision } from '../../validation/run-command-workflow.validator.js';
import {
  commandReplyTopic,
  runCommandDecisionStepName,
  unknownResolutionTopic,
} from '../dbos-names.js';
import { commandWorkflowId } from '../workflow-id.js';
import {
  createRunCommandDecision,
  createRunCommandEvent,
  prospectiveRunCommandReceipt,
} from './run-command-decision.js';
import { UnknownOutcomeRegistry } from './unknown-outcome-registry.js';

export interface RunCommandContext {
  readonly cancellationRequested: boolean;
  readonly eventBudgetExceeded: boolean;
  readonly executions: number;
  readonly maximumExecutions: number;
  readonly rootCompletionFenced: boolean;
  appendEvent(event: RunEventDraft): Promise<boolean>;
  cancelRun(commandId: string): Promise<void>;
  consumeExecution(): void;
}

/** Durable command and unknown-outcome state owned by a current root coordinator. */
export class RunCommandCoordinator {
  private readonly decisions = new Map<string, RunCommandReceipt | 'dispatchFailed'>();
  private readonly unknownOutcomes = new UnknownOutcomeRegistry();

  registerUnknownOutcome(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'unknownOutcomeWaiting' }>,
  ): void {
    this.unknownOutcomes.register(
      message.workflowId,
      message.request,
      message.reconciliationRound,
      message.retry,
    );
  }

  consumeRetryPermit(commandId: string, attemptId: string): boolean {
    return this.unknownOutcomes.consumeRetryPermit(commandId, attemptId);
  }

  cancelRetryPermits(): void {
    this.unknownOutcomes.cancelRetryPermits();
  }

  async decide(input: CommandDispatchWorkflowInput, context: RunCommandContext): Promise<void> {
    const retained = this.decisions.get(input.commandId);
    if (retained !== undefined) {
      await this.reply(input.commandId, retained);
      return;
    }
    if (context.rootCompletionFenced) {
      const receipt: RunCommandReceipt = {
        status: 'rejected',
        commandId: input.commandId,
        reason: 'run_already_terminal',
      };
      this.decisions.set(input.commandId, receipt);
      await this.reply(input.commandId, receipt);
      return;
    }
    if (context.eventBudgetExceeded) {
      this.decisions.set(input.commandId, 'dispatchFailed');
      await this.reply(input.commandId, 'dispatchFailed');
      return;
    }

    const waiting =
      input.command.kind === 'resolveUnknownOutcome'
        ? this.unknownOutcomes.get(input.command.input.attemptId)
        : undefined;
    const receipt = prospectiveRunCommandReceipt(input, {
      cancellationRequested: context.cancellationRequested,
      executions: context.executions,
      maximumExecutions: context.maximumExecutions,
      waiting,
    });
    if (!(await context.appendEvent(createRunCommandEvent(input, receipt)))) {
      this.decisions.set(input.commandId, 'dispatchFailed');
      await this.reply(input.commandId, 'dispatchFailed');
      return;
    }
    const decision = parseRunCommandDecision(
      await DBOS.runStep(async () => createRunCommandDecision(input, receipt), {
        name: runCommandDecisionStepName(input.commandId),
      }),
    );
    this.decisions.set(input.commandId, receipt);
    await this.apply(input, decision, receipt, context);
    await this.reply(input.commandId, receipt);
  }

  sendAllUnknownResolutions(directive: UnknownResolutionDirective): Promise<void> {
    return this.sendUnknownResolutions([...this.unknownOutcomes.attemptIds()], directive);
  }

  private async apply(
    input: CommandDispatchWorkflowInput,
    decision: RunCommandDecision,
    receipt: RunCommandReceipt,
    context: RunCommandContext,
  ): Promise<void> {
    if (receipt.status === 'rejected') {
      return;
    }
    if (input.command.kind === 'cancelRun') {
      if (!context.cancellationRequested) {
        await context.cancelRun(input.commandId);
      }
      return;
    }
    if (input.command.kind !== 'resolveUnknownOutcome') {
      return;
    }
    const waiting = this.unknownOutcomes.markResolved(input.command.input.attemptId);
    if (waiting === undefined) {
      throw new Error('Accepted resolution target is not waiting.');
    }
    const resolution = input.command.input.resolution;
    if (resolution.kind === 'adoptSuccess') {
      await this.sendUnknownResolution(waiting.request.attemptId, {
        kind: 'adoptSuccess',
        commandId: decision.commandId,
        outcome: resolution.outcome,
        ...(resolution.output === undefined ? {} : { output: resolution.output }),
      });
      return;
    }
    if (resolution.kind === 'markFailed') {
      await this.sendUnknownResolution(waiting.request.attemptId, {
        kind: 'markFailed',
        commandId: decision.commandId,
        errorCode: unknownOutcomeResolvedFailureCode,
      });
      return;
    }

    context.consumeExecution();
    const newAttemptId = createAttemptId({
      nodeInstanceId: waiting.request.nodeInstanceId,
      attemptOrdinal: waiting.request.attemptOrdinal + 1,
    });
    this.unknownOutcomes.addRetryPermit(
      decision.commandId,
      waiting.request.attemptId,
      newAttemptId,
    );
    await this.sendUnknownResolution(waiting.request.attemptId, {
      kind: 'retry',
      commandId: decision.commandId,
      attemptId: newAttemptId,
    });
  }

  private async sendUnknownResolutions(
    attemptIds: readonly string[],
    directive: UnknownResolutionDirective,
  ): Promise<void> {
    await attemptIds.reduce<Promise<void>>(async (previous, attemptId) => {
      await previous;
      await this.sendUnknownResolution(attemptId, directive);
    }, Promise.resolve());
  }

  private sendUnknownResolution(
    attemptId: string,
    directive: UnknownResolutionDirective,
  ): Promise<void> {
    const waiting = this.unknownOutcomes.get(attemptId);
    return waiting === undefined
      ? Promise.resolve()
      : DBOS.send(waiting.workflowId, directive, unknownResolutionTopic(attemptId));
  }

  private reply(commandId: string, receipt: RunCommandReceipt | 'dispatchFailed'): Promise<void> {
    const result: CommandDispatchWorkflowResult =
      receipt === 'dispatchFailed'
        ? { status: 'dispatchFailed', commandId }
        : { status: 'receipt', receipt };
    return DBOS.send(commandWorkflowId(commandId), result, commandReplyTopic);
  }
}
