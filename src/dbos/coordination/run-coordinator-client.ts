import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import type { ExecuteNodeEffect } from '../../pipeline/interpreter/interpreter-context.js';
import type { PipelineEventSink } from '../../pipeline/interpreter/pipeline-event-sink.js';
import { parseExecutionReservation } from '../../validation/run-coordinator-message.validator.js';
import { runCoordinatorMessageTopic, runCoordinatorReplyTopic } from '../dbos-names.js';
import type { NodeExecutionStep } from '../steps/node-execution-step.js';
import { isActiveWorkflowStatus } from '../workflow-status.js';

export class RunCoordinatorClient implements PipelineEventSink {
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  async write(
    type: string,
    options: { readonly path?: string; readonly errorCode?: string } = {},
  ): Promise<void> {
    await this.send({ kind: 'event', event: { type, ...options } });
  }

  executionStep(step: NodeExecutionStep): ExecuteNodeEffect {
    return async (request, timeoutMs) => {
      if (!(await this.reserveExecution(request))) {
        return { kind: 'executionLimitExceeded' };
      }

      return step.execute(request, timeoutMs);
    };
  }

  async registerScope(workflowId: string): Promise<void> {
    await this.send({ kind: 'scopeRegistered', workflowId });
  }

  async scopeSettled(): Promise<void> {
    const workflowId = this.workflowId();
    await this.send({ kind: 'scopeSettled', workflowId });
  }

  private async reserveExecution(request: RunExecutorRequest): Promise<boolean> {
    const workflowId = this.workflowId();
    await this.send({
      kind: 'reserveExecution',
      executionId: request.executionId,
      replyWorkflowId: workflowId,
    });

    const response = parseExecutionReservation(await this.receiveReservation());
    if (response.executionId !== request.executionId) {
      throw new Error('Run execution received a reservation for another execution.');
    }

    return response.granted;
  }

  private async receiveReservation(): Promise<unknown> {
    while (true) {
      const response = await DBOS.recv(runCoordinatorReplyTopic, { timeoutSeconds: 60 });
      if (response !== null) {
        return response;
      }

      const run = await DBOS.getWorkflowStatus(this.runId);
      if (run === null || !isActiveWorkflowStatus(run.status)) {
        throw new Error('Run coordinator terminated before reserving the execution.');
      }
    }
  }

  private async send(message: RunCoordinatorMessage): Promise<void> {
    await DBOS.send(this.runId, message, runCoordinatorMessageTopic);
  }

  private workflowId(): string {
    const workflowId = DBOS.workflowID;
    if (workflowId === undefined) {
      throw new Error('Pipeline execution has no DBOS workflow ID.');
    }

    return workflowId;
  }
}
