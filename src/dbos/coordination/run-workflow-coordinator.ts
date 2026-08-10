import { DBOS } from '@dbos-inc/dbos-sdk';

import type {
  ExecutionReservation,
  RunCoordinatorMessage,
} from '../../contracts/workflow/run-coordinator-message.js';
import type { RunWorkflowResult } from '../../contracts/workflow/run-workflow-result.js';
import { parseRunCoordinatorMessage } from '../../validation/run-coordinator-message.validator.js';
import { runCoordinatorMessageTopic, runCoordinatorReplyTopic } from '../dbos-names.js';
import type { DbosRunEventStream } from '../streams/run-event-stream.js';
import { isActiveWorkflowStatus } from '../workflow-status.js';

export interface RunExecutionHandle {
  readonly workflowID: string;
  getResult(): Promise<RunWorkflowResult>;
}

export class RunWorkflowCoordinator {
  private readonly events: DbosRunEventStream;
  private readonly maximumExecutions: number;
  private readonly registeredScopes = new Set<string>();
  private readonly settledScopes = new Set<string>();
  private readonly terminalScopesAwaitingSettlement = new Set<string>();
  private executions = 0;

  constructor(events: DbosRunEventStream, maximumExecutions: number) {
    this.events = events;
    this.maximumExecutions = maximumExecutions;
  }

  async execute(handle: RunExecutionHandle): Promise<RunWorkflowResult> {
    this.registeredScopes.add(handle.workflowID);
    while (!this.allScopesSettled(handle.workflowID)) {
      await this.advance();
    }

    return handle.getResult();
  }

  private async process(message: RunCoordinatorMessage): Promise<void> {
    switch (message.kind) {
      case 'event':
        await this.events.append(message.event);
        return;
      case 'reserveExecution':
        await this.reserveExecution(message);
        return;
      case 'scopeRegistered':
        this.registeredScopes.add(message.workflowId);
        return;
      case 'scopeSettled':
        this.settledScopes.add(message.workflowId);
        this.terminalScopesAwaitingSettlement.delete(message.workflowId);
        return;
    }

    message satisfies never;
  }

  private allScopesSettled(executionWorkflowId: string): boolean {
    return (
      this.settledScopes.has(executionWorkflowId) &&
      [...this.registeredScopes].every((workflowId) => this.settledScopes.has(workflowId))
    );
  }

  private async reserveExecution(
    message: Extract<RunCoordinatorMessage, { readonly kind: 'reserveExecution' }>,
  ): Promise<void> {
    const granted = this.executions < this.maximumExecutions;
    if (granted) {
      this.executions += 1;
    }

    const reservation: ExecutionReservation = {
      attemptId: message.attemptId,
      granted,
    };
    await DBOS.send(message.replyWorkflowId, reservation, runCoordinatorReplyTopic);
  }

  private async advance(): Promise<void> {
    const message = await DBOS.recv(runCoordinatorMessageTopic, { timeoutSeconds: 60 });
    if (message !== null) {
      await this.process(parseRunCoordinatorMessage(message));
      return;
    }

    for (const workflowId of this.registeredScopes) {
      if (this.settledScopes.has(workflowId)) {
        continue;
      }

      const status = await DBOS.getWorkflowStatus(workflowId);
      if (status !== null && isActiveWorkflowStatus(status.status)) {
        this.terminalScopesAwaitingSettlement.delete(workflowId);
        continue;
      }
      if (this.terminalScopesAwaitingSettlement.has(workflowId)) {
        throw new Error(`Run scope ${workflowId} terminated without settlement.`);
      }

      this.terminalScopesAwaitingSettlement.add(workflowId);
    }
  }
}
