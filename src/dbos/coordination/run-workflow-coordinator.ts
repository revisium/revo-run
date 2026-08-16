import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunEventDraft } from '../../contracts/run/run-event.js';
import type { ScopeDirective } from '../../contracts/workflow/run-command-workflow.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { parseRunCoordinatorMessage } from '../../validation/run-coordinator-message.validator.js';
import { runCoordinatorTopic } from '../dbos-names.js';
import type { ProviderCallRegistry } from '../executor/provider-call-registry.js';
import {
  type DbosRunEventStream,
  type RunEventBudgetFailure,
  RunEventBudgetExceededError,
} from '../streams/run-event-stream.js';
import { runWorkflowId } from '../workflow-id.js';
import { DelayCancellationEventAdmission } from './delay-cancellation-event-admission.js';
import { durableOperationLoop } from './durable-operation-loop.js';
import { waitingGateFenceDirective } from './human-gate-resolutions.js';
import { orphanHealthCheckSeconds } from './orphan-health-check.js';
import { RunCommandCoordinator, type RunCommandContext } from './run-command-coordinator.js';
import { RunExecutionReservations } from './run-execution-reservations.js';
import { RunScopeAdmission } from './run-scope-admission.js';
import { RunScopeRegistry } from './run-scope-registry.js';
import type { ScopeCancellationRegistry } from './scope-cancellation-registry.js';

interface RunExecutionHandle {
  readonly workflowID: string;
  getResult(): Promise<RunWorkflowResult>;
}

export class RunWorkflowCoordinator {
  private readonly scopes = new RunScopeRegistry();
  private readonly commands = new RunCommandCoordinator();
  private readonly admissions: RunScopeAdmission;
  private readonly reservations: RunExecutionReservations;
  private readonly delayCancellationEvents = new DelayCancellationEventAdmission();
  private eventBudgetFailure: RunEventBudgetFailure | undefined;
  private rootScopeWorkflowId: string | undefined;
  private rootCompletionFenced = false;
  private cancellationRequested = false;
  private cancellationCommandId: string | undefined;

  constructor(
    private readonly runId: string,
    private readonly events: Pick<DbosRunEventStream, 'append'>,
    private readonly maximumExecutions: number,
    private readonly cancellation: ScopeCancellationRegistry,
    private readonly providerCalls: ProviderCallRegistry,
  ) {
    this.admissions = new RunScopeAdmission(runId, this.scopes, cancellation);
    this.reservations = new RunExecutionReservations(maximumExecutions);
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
    await this.providerCalls.waitForIdle(this.runId);
    const result = await handle.getResult();
    if (this.eventBudgetFailure !== undefined) {
      return { status: 'failed', outcome: this.eventBudgetFailure };
    }
    return this.cancellationRequested ? { status: 'cancelled', outcome: 'cancelled' } : result;
  }

  private async process(message: RunCoordinatorMessage): Promise<void> {
    if ('command' in message) {
      await this.commands.decide(message, this.commandContext());
      return;
    }
    switch (message.kind) {
      case 'event':
        this.scopes.assertRegistered(message.workflowId);
        if (!this.fenced) {
          await this.appendEvent(message.event);
        } else {
          await this.delayCancellationEvents.appendIfAllowed(message, {
            cancellationRequested: this.cancellationRequested,
            eventBudgetExceeded: this.eventBudgetFailure !== undefined,
            senderCancelled: this.scopes.cancellationFence(message.workflowId) !== undefined,
            senderOwnsScope: this.scopes.ownsScope(message.workflowId, message.event.data.scopeId),
            appendEvent: (event) => this.appendEvent(event),
          });
        }
        await this.replyScope(message.workflowId);
        return;
      case 'reserveExecution':
        await this.reserveExecution(message);
        return;
      case 'scopeAdmission':
        await this.admissions.admit(message, {
          cancellationRequested: this.cancellationRequested,
          ...(this.cancellationCommandId === undefined
            ? {}
            : { cancellationCommandId: this.cancellationCommandId }),
          ...(this.eventBudgetFailure === undefined
            ? {}
            : { eventBudgetFailure: this.eventBudgetFailure }),
        });
        return;
      case 'scopeReady':
        this.scopes.assertLineage(message.workflowId, message.parentWorkflowId);
        if ('requestId' in message) {
          this.scopes.assertAdmission(message.workflowId, message.requestId, message.admissionId);
        }
        this.scopes.markReady(message.workflowId);
        await this.replyScope(message.workflowId);
        return;
      case 'scopeBoundary':
        this.scopes.assertRegistered(message.workflowId);
        await this.replyScope(message.workflowId);
        return;
      case 'inlineScopeOwnership':
        this.scopes.registerInlineOwnership(message);
        await this.replyScope(message.workflowId);
        return;
      case 'scopeCancellation':
        await this.cancelChildScopes(
          message.workflowId,
          message.childWorkflowIds,
          message.joinNodeInstanceId,
        );
        return;
      case 'scopeFinish':
        await this.finishScope(message.workflowId);
        return;
      case 'scopeSettled':
        this.scopes.settle(message.workflowId);
        await this.scopes.acknowledgeSettlement(message.workflowId);
        return;
      case 'unknownOutcomeWaiting':
        this.scopes.assertRegistered(message.workflowId);
        this.commands.registerUnknownOutcome(message);
        await this.replyScope(message.workflowId);
        return;
      case 'humanGateWaiting':
        this.scopes.assertRegistered(message.workflowId);
        await this.commands.registerHumanGate(
          message,
          waitingGateFenceDirective(
            this.eventBudgetFailure !== undefined,
            this.cancellationRequested,
            this.scopes.cancellationFence(message.workflowId) !== undefined,
          ),
        );
        await this.replyScope(message.workflowId);
        return;
      case 'humanGateDeadlineReached':
        this.scopes.assertRegistered(message.workflowId);
        await this.commands.resolveGateDeadline(
          message.gateInstanceId,
          message.workflowId,
          (event) => this.appendEvent(event),
        );
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

  private async cancelChildScopes(
    parentWorkflowId: string,
    childWorkflowIds: readonly string[],
    joinNodeInstanceId: string,
  ): Promise<void> {
    this.scopes.assertDirectChildren(parentWorkflowId, childWorkflowIds);
    const cancelled = this.scopes.cancelSubtrees(childWorkflowIds, {
      source: 'joinDecision',
      id: joinNodeInstanceId,
    });
    cancelled.forEach((workflowId) => this.cancellation.cancelScope(this.scopeId(workflowId)));
    await this.scopes.directMany(cancelled, { kind: 'cancel' });
    await this.commands.sendGateResolutionsForWorkflows(cancelled, (event) =>
      this.appendEvent(event),
    );
    await this.replyScope(parentWorkflowId);
  }

  private async finishScope(workflowId: string): Promise<void> {
    this.scopes.assertRegistered(workflowId);
    const directive = this.scopeDirective(workflowId);
    if (directive.kind === 'continue') {
      this.scopes.finish(workflowId);
      this.rootCompletionFenced ||= workflowId === this.rootScopeWorkflowId;
    }
    await this.scopes.reply(workflowId, directive);
  }

  private async reserveExecution(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'reserveExecution' }>,
  ): Promise<void> {
    this.scopes.assertRegistered(message.replyWorkflowId);
    await this.reservations.reserve(message, {
      fenced: this.fenced,
      scopeCancelled: this.scopes.cancellationFence(message.replyWorkflowId) !== undefined,
      consumeRetryPermit: (commandId, attemptId) =>
        this.commands.consumeRetryPermit(commandId, attemptId),
    });
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
      await this.commands.sendAllUnknownResolutions({ kind: 'fail' });
      await this.commands.sendAllGateResolutions('fail', (failEvent) =>
        this.appendEvent(failEvent),
      );
      this.cancellation.cancelRun(this.runId);
      return false;
    }
  }

  private commandContext(): RunCommandContext {
    return {
      cancellationRequested: this.cancellationRequested,
      eventBudgetExceeded: this.eventBudgetFailure !== undefined,
      executions: this.reservations.executions,
      maximumExecutions: this.maximumExecutions,
      rootCompletionFenced: this.rootCompletionFenced,
      appendEvent: (event) => this.appendEvent(event),
      cancelRun: (commandId) => this.cancelRun(commandId),
      consumeExecution: () => this.reservations.consumeExecution(),
    };
  }

  private async advance(): Promise<void> {
    const message = await DBOS.recv(runCoordinatorTopic, {
      timeoutSeconds: orphanHealthCheckSeconds,
    });
    if (message !== null) {
      await this.process(parseRunCoordinatorMessage(message));
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

  private async cancelRun(commandId: string): Promise<void> {
    this.cancellationRequested = true;
    this.cancellationCommandId = commandId;
    this.scopes.cancelAll({ source: 'run', id: commandId });
    await this.scopes.directAll({ kind: 'cancel' });
    await this.commands.sendAllUnknownResolutions({ kind: 'cancel' });
    await this.commands.sendAllGateResolutions('cancel', (event) => this.appendEvent(event));
    this.cancellation.cancelRun(this.runId);
    this.commands.cancelRetryPermits();
  }

  private scopeId(workflowId: string): string {
    return workflowId.slice('rr:scope:'.length);
  }

  private scopeDirective(workflowId: string): ScopeDirective {
    return this.scopes.directive(workflowId, this.currentFenceDirective());
  }

  private replyScope(workflowId: string): Promise<void> {
    return this.scopes.reply(workflowId, this.scopeDirective(workflowId));
  }
}
