import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import type { ExecuteNodeEffect } from '../../pipeline/interpreter/interpreter-context.js';
import type {
  PipelineEventDraft,
  PipelineEventSink,
} from '../../pipeline/interpreter/pipeline-event-sink.js';
import { parseExecutionReservation } from '../../validation/run-coordinator-message.validator.js';
import { runCoordinatorMessageTopic, runCoordinatorReplyTopic } from '../dbos-names.js';
import type { NodeExecutionStep } from '../steps/node-execution-step.js';
import { runWorkflowId } from '../workflow-id.js';
import { isActiveWorkflowStatus } from '../workflow-status.js';

export class RunCoordinatorClient implements PipelineEventSink {
  private readonly rootWorkflowId: string;

  constructor(runId: string) {
    this.rootWorkflowId = runWorkflowId(runId);
  }

  async write(event: PipelineEventDraft): Promise<void> {
    await this.send({ kind: 'event', event });
  }

  executionStep(step: NodeExecutionStep): ExecuteNodeEffect {
    return async (request, timeoutMs, recovery, nextReconciliationRound) => {
      if (!(await this.reserveExecution(request))) {
        return { kind: 'executionLimitExceeded' };
      }

      await this.write({
        type: 'nodeExecution.started',
        data: {
          scopeId: request.scopeId,
          authoredNodeId: request.authoredNodeId,
          nodeInstanceId: request.nodeInstanceId,
          attemptId: request.attemptId,
          attemptOrdinal: request.attemptOrdinal,
        },
      });
      return step.execute(request, timeoutMs, recovery, nextReconciliationRound);
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
      attemptId: request.attemptId,
      replyWorkflowId: workflowId,
    });

    const response = parseExecutionReservation(await this.receiveReservation());
    if (response.attemptId !== request.attemptId) {
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

      const run = await DBOS.getWorkflowStatus(this.rootWorkflowId);
      if (run === null || !isActiveWorkflowStatus(run.status)) {
        throw new Error('Run coordinator terminated before reserving the execution.');
      }
    }
  }

  private async send(message: RunCoordinatorMessage): Promise<void> {
    await DBOS.send(this.rootWorkflowId, message, runCoordinatorMessageTopic);
  }

  private workflowId(): string {
    const workflowId = DBOS.workflowID;
    if (workflowId === undefined) {
      throw new Error('Pipeline execution has no DBOS workflow ID.');
    }

    return workflowId;
  }
}
