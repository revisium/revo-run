import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunCommandReceipt } from '../../contracts/run/run-command.js';
import type { RunEventDraft } from '../../contracts/run/run-event.js';
import type {
  CommandDispatchWorkflowInput,
  CommandDispatchWorkflowResult,
  RunCommandDecision,
  ScopeDirective,
  UnknownResolutionDirective,
} from '../../contracts/workflow/run-command-workflow.js';
import { unknownOutcomeResolvedFailureCode } from '../../contracts/workflow/run-command-workflow.js';
import type { RunCoordinatorV2Message } from '../../contracts/workflow/run-coordinator-v2-message.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { createAttemptId } from '../../pipeline/identity/execution-identity.js';
import { parseRunCommandDecision } from '../../validation/run-command-workflow.validator.js';
import { parseRunCoordinatorV2Message } from '../../validation/run-coordinator-v2-message.validator.js';
import {
  commandReplyV2Topic,
  runCommandDecisionStepName,
  runCoordinatorReplyTopic,
  runCoordinatorV2Topic,
  unknownResolutionV2Topic,
} from '../dbos-names.js';
import {
  type DbosRunEventStream,
  type RunEventBudgetFailure,
  RunEventBudgetExceededError,
} from '../streams/run-event-stream.js';
import { commandWorkflowId, runWorkflowId } from '../workflow-id.js';
import { durableOperationLoop } from './durable-operation-loop.js';
import { orphanHealthCheckSeconds } from './orphan-health-check.js';
import {
  createRunCommandDecision,
  createRunCommandEvent,
  prospectiveRunCommandReceipt,
} from './run-command-decision.js';
import { RunScopeRegistry } from './run-scope-registry.js';
import type { ScopeCancellationRegistry } from './scope-cancellation-registry.js';
import { UnknownOutcomeRegistry } from './unknown-outcome-registry.js';

interface RunExecutionHandle {
  readonly workflowID: string;
  getResult(): Promise<RunWorkflowResult>;
}

export class RunWorkflowV2Coordinator {
  private readonly runId: string;
  private readonly events: Pick<DbosRunEventStream, 'append'>;
  private readonly maximumExecutions: number;
  private readonly cancellation: ScopeCancellationRegistry;
  private readonly scopes = new RunScopeRegistry();
  private readonly decisions = new Map<string, RunCommandReceipt | 'dispatchFailed'>();
  private readonly unknownOutcomes = new UnknownOutcomeRegistry();
  private eventBudgetFailure: RunEventBudgetFailure | undefined;
  private rootCompletionFenced = false;
  private rootScopeWorkflowId: string | undefined;
  private cancellationRequested = false;
  private executions = 0;

  constructor(
    runId: string,
    events: Pick<DbosRunEventStream, 'append'>,
    maximumExecutions: number,
    cancellation: ScopeCancellationRegistry,
  ) {
    this.runId = runId;
    this.events = events;
    this.maximumExecutions = maximumExecutions;
    this.cancellation = cancellation;
  }

  get eventBudgetExceeded(): boolean {
    return this.eventBudgetFailure !== undefined;
  }

  get cancelled(): boolean {
    return this.cancellationRequested;
  }

  registerRootScope(workflowId: string): void {
    this.scopes.registerRoot(workflowId, runWorkflowId(this.runId));
    this.rootScopeWorkflowId = workflowId;
  }

  async execute(handle: RunExecutionHandle): Promise<RunWorkflowResult> {
    await this.awaitSettlement(handle.workflowID);
    const result = await handle.getResult();
    if (this.eventBudgetFailure !== undefined) {
      return { status: 'failed', outcome: this.eventBudgetFailure };
    }
    return this.cancellationRequested ? { status: 'cancelled', outcome: 'cancelled' } : result;
  }

  private async process(message: RunCoordinatorV2Message): Promise<void> {
    if ('command' in message) {
      await this.decideCommand(message);
      return;
    }
    switch (message.kind) {
      case 'event':
        this.scopes.assertRegistered(message.workflowId);
        if (!this.fenced) {
          await this.appendEvent(message.event);
        }
        await this.scopes.reply(message.workflowId, this.currentFenceDirective());
        return;
      case 'reserveExecution':
        await this.reserveExecution(message);
        return;
      case 'scopeRegistered':
        this.scopes.registerChild(message.workflowId, message.parentWorkflowId);
        await this.scopes.reply(message.parentWorkflowId, this.currentFenceDirective());
        return;
      case 'scopeReady':
        this.scopes.assertLineage(message.workflowId, message.parentWorkflowId);
        this.scopes.markReady(message.workflowId);
        await this.scopes.reply(message.workflowId, this.currentFenceDirective());
        return;
      case 'scopeBoundary':
        this.scopes.assertRegistered(message.workflowId);
        await this.scopes.reply(message.workflowId, this.currentFenceDirective());
        return;
      case 'scopeFinish': {
        this.scopes.assertRegistered(message.workflowId);
        const directive = this.currentFenceDirective();
        if (directive.kind === 'continue') {
          this.scopes.finish(message.workflowId);
          if (message.workflowId === this.rootScopeWorkflowId) {
            this.rootCompletionFenced = true;
          }
        }
        await this.scopes.reply(message.workflowId, directive);
        return;
      }
      case 'scopeSettled':
        this.scopes.settle(message.workflowId);
        await this.scopes.acknowledgeSettlement(message.workflowId);
        return;
      case 'unknownOutcomeWaiting':
        this.scopes.assertRegistered(message.workflowId);
        this.unknownOutcomes.register(
          message.workflowId,
          message.request,
          message.reconciliationRound,
          message.retry,
        );
        await this.scopes.reply(message.workflowId, this.currentFenceDirective());
        return;
    }
  }

  private get fenced(): boolean {
    return this.cancellationRequested || this.eventBudgetFailure !== undefined;
  }

  private currentFenceDirective(): ScopeDirective {
    if (this.eventBudgetFailure !== undefined) {
      return { kind: 'fail' };
    }
    return this.cancellationRequested ? { kind: 'cancel' } : { kind: 'continue' };
  }

  private async decideCommand(input: CommandDispatchWorkflowInput): Promise<void> {
    const retained = this.decisions.get(input.commandId);
    if (retained !== undefined) {
      await this.replyToCommand(input.commandId, retained);
      return;
    }

    if (this.rootCompletionFenced) {
      const receipt: RunCommandReceipt = {
        status: 'rejected',
        commandId: input.commandId,
        reason: 'run_already_terminal',
      };
      this.decisions.set(input.commandId, receipt);
      await this.replyToCommand(input.commandId, receipt);
      return;
    }

    if (this.eventBudgetFailure !== undefined) {
      this.decisions.set(input.commandId, 'dispatchFailed');
      await this.replyToCommand(input.commandId, 'dispatchFailed');
      return;
    }

    const waiting =
      input.command.kind === 'resolveUnknownOutcome'
        ? this.unknownOutcomes.get(input.command.input.attemptId)
        : undefined;
    const receipt = prospectiveRunCommandReceipt(input, {
      cancellationRequested: this.cancellationRequested,
      executions: this.executions,
      maximumExecutions: this.maximumExecutions,
      waiting,
    });
    const event = createRunCommandEvent(input, receipt);
    if (!(await this.appendEvent(event))) {
      this.decisions.set(input.commandId, 'dispatchFailed');
      await this.replyToCommand(input.commandId, 'dispatchFailed');
      return;
    }

    const decision = parseRunCommandDecision(
      await DBOS.runStep(async () => createRunCommandDecision(input, receipt), {
        name: runCommandDecisionStepName(input.commandId),
      }),
    );
    this.decisions.set(input.commandId, receipt);
    await this.applyDecision(input, decision, receipt);
    await this.replyToCommand(input.commandId, receipt);
  }

  private async applyDecision(
    input: CommandDispatchWorkflowInput,
    decision: RunCommandDecision,
    receipt: RunCommandReceipt,
  ): Promise<void> {
    if (receipt.status === 'rejected') {
      return;
    }
    if (input.command.kind === 'cancelRun') {
      if (!this.cancellationRequested) {
        this.cancellationRequested = true;
        await this.scopes.directAll({ kind: 'cancel' });
        await this.sendAllUnknownResolutions([...this.unknownOutcomes.attemptIds()], {
          kind: 'cancel',
        });
        this.cancellation.cancelRun(this.runId);
        this.unknownOutcomes.cancelRetryPermits();
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
    this.executions += 1;
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

  private async reserveExecution(
    message: Extract<RunCoordinatorV2Message, { readonly kind: 'reserveExecution' }>,
  ): Promise<void> {
    this.scopes.assertRegistered(message.replyWorkflowId);
    let granted = false;
    if (!this.fenced && message.permitCommandId !== undefined) {
      granted = this.unknownOutcomes.consumeRetryPermit(message.permitCommandId, message.attemptId);
    } else if (!this.fenced && this.executions < this.maximumExecutions) {
      this.executions += 1;
      granted = true;
    }
    await DBOS.send(
      message.replyWorkflowId,
      { attemptId: message.attemptId, granted },
      runCoordinatorReplyTopic,
    );
  }

  private async appendEvent(event: RunEventDraft): Promise<boolean> {
    if (this.eventBudgetFailure !== undefined) {
      return false;
    }
    try {
      await this.events.append(event);
      return true;
    } catch (error) {
      if (!(error instanceof RunEventBudgetExceededError)) {
        throw error;
      }
      this.eventBudgetFailure = error.outcome;
      await this.scopes.directAll({ kind: 'fail' });
      await this.sendAllUnknownResolutions([...this.unknownOutcomes.attemptIds()], {
        kind: 'fail',
      });
      this.cancellation.cancelRun(this.runId);
      return false;
    }
  }

  private sendUnknownResolution(
    attemptId: string,
    directive: UnknownResolutionDirective,
  ): Promise<void> {
    const waiting = this.unknownOutcomes.get(attemptId);
    if (waiting === undefined) {
      return Promise.resolve();
    }
    return DBOS.send(waiting.workflowId, directive, unknownResolutionV2Topic(attemptId));
  }

  private replyToCommand(
    commandId: string,
    receipt: RunCommandReceipt | 'dispatchFailed',
  ): Promise<void> {
    const result: CommandDispatchWorkflowResult =
      receipt === 'dispatchFailed'
        ? { status: 'dispatchFailed', commandId }
        : { status: 'receipt', receipt };
    return DBOS.send(commandWorkflowId(commandId), result, commandReplyV2Topic);
  }

  private async advance(): Promise<void> {
    const message = await DBOS.recv(runCoordinatorV2Topic, {
      timeoutSeconds: orphanHealthCheckSeconds,
    });
    if (message !== null) {
      await this.process(parseRunCoordinatorV2Message(message));
      return;
    }
    await this.scopes.assertUnsettledActive();
  }

  private async awaitSettlement(rootWorkflowId: string): Promise<void> {
    for await (const _ of durableOperationLoop(() => this.advance())) {
      if (this.scopes.allSettled(rootWorkflowId)) {
        return;
      }
    }
    throw new Error('Durable coordinator inbox loop terminated unexpectedly.');
  }

  private async sendAllUnknownResolutions(
    attemptIds: readonly string[],
    directive: UnknownResolutionDirective,
  ): Promise<void> {
    await attemptIds.reduce<Promise<void>>(async (previous, attemptId) => {
      await previous;
      await this.sendUnknownResolution(attemptId, directive);
    }, Promise.resolve());
  }
}
