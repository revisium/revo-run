import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RecoveryPolicy, RetryPolicy } from '../../contracts/pipeline/task-policy.js';
import type { UnknownResolutionDirective } from '../../contracts/workflow/run-command-workflow.js';
import type {
  RunCoordinatorMessage,
  ScopeStartFenceReply,
} from '../../contracts/workflow/run-coordinator-message.js';
import type {
  PipelineEventDraft,
  PipelineEventSink,
} from '../../pipeline/interpreter/pipeline-event-sink.js';
import {
  parseScopeDirective,
  parseScopeSettlementAcknowledgement,
  parseUnknownResolutionDirective,
} from '../../validation/run-command-workflow.validator.js';
import {
  parseExecutionReservation,
  parseScopeStartFenceReply,
} from '../../validation/run-coordinator-message.validator.js';
import {
  runCoordinatorReplyTopic,
  runCoordinatorTopic,
  retryBackoffStepName,
  scopeAdmissionReplyTopic,
  scopeDirectiveTopic,
  scopeReplyTopic,
  scopeSettlementTopic,
  unknownOutcomeReadyStepName,
  unknownOutcomeResolutionStepName,
  unknownResolutionTopic,
} from '../dbos-names.js';
import { runWorkflowId } from '../workflow-id.js';
import { isActiveWorkflowStatus } from '../workflow-status.js';
import { durableOperationLoop } from './durable-operation-loop.js';
import { orphanHealthCheckSeconds } from './orphan-health-check.js';

export class ScopeCancellationError extends Error {}

export class ScopeFailureFenceError extends Error {}

export class RunCoordinatorClient implements PipelineEventSink {
  private readonly rootWorkflowId: string;
  private boundarySequence = 0;

  constructor(private readonly runId: string) {
    this.rootWorkflowId = runWorkflowId(runId);
  }

  async ready(parentWorkflowId: string, startFence?: ScopeStartFenceReply): Promise<void> {
    const workflowId = this.workflowId();
    await this.send({
      kind: 'scopeReady',
      workflowId,
      parentWorkflowId,
      ...(startFence === undefined
        ? {}
        : { requestId: startFence.requestId, admissionId: startFence.admissionId }),
    });
    await this.receiveReply();
    if (startFence?.directive === 'startCancelled') {
      throw new ScopeCancellationError(
        `Scope start was cancelled by ${startFence.cancellation.source} ${startFence.cancellation.id}.`,
      );
    }
  }

  async boundary(): Promise<void> {
    this.boundarySequence += 1;
    await this.send({
      kind: 'scopeBoundary',
      workflowId: this.workflowId(),
      boundaryId: `boundary-${this.boundarySequence}`,
    });
    await this.receiveReply();
  }

  async write(event: PipelineEventDraft): Promise<void> {
    await this.send({ kind: 'event', workflowId: this.workflowId(), event });
    await this.receiveReply();
  }

  async reserveExecution(request: RunExecutorRequest, permitCommandId?: string): Promise<boolean> {
    await this.send({
      kind: 'reserveExecution',
      attemptId: request.attemptId,
      replyWorkflowId: this.workflowId(),
      ...(permitCommandId === undefined ? {} : { permitCommandId }),
    });
    const reservation = parseExecutionReservation(await this.receive(runCoordinatorReplyTopic));
    if (reservation.attemptId !== request.attemptId) {
      throw new Error('Run execution received a reservation for another execution.');
    }
    return reservation.granted;
  }

  executionStarted(request: RunExecutorRequest): Promise<void> {
    return this.write({
      type: 'nodeExecution.started',
      data: {
        scopeId: request.scopeId,
        authoredNodeId: request.authoredNodeId,
        nodeInstanceId: request.nodeInstanceId,
        attemptId: request.attemptId,
        attemptOrdinal: request.attemptOrdinal,
      },
    });
  }

  async waitForRetry(request: RunExecutorRequest, delayMs: number): Promise<void> {
    await DBOS.runStep(async () => ({ attemptId: request.attemptId, delayMs }), {
      name: retryBackoffStepName(request.attemptId),
    });
    const response = await DBOS.recv(scopeDirectiveTopic, { timeoutSeconds: delayMs / 1_000 });
    if (response !== null) {
      this.assertContinue(response);
    }
    await this.boundary();
  }

  async waitForUnknownOutcome(
    request: RunExecutorRequest,
    recovery: RecoveryPolicy,
    retry: RetryPolicy | undefined,
    reconciliationRound: number,
  ): Promise<UnknownResolutionDirective> {
    await this.send({
      kind: 'unknownOutcomeWaiting',
      workflowId: this.workflowId(),
      request,
      attemptOrdinal: request.attemptOrdinal,
      reconciliationRound,
      recovery,
      ...(retry === undefined ? {} : { retry }),
    });
    await this.receiveReply();
    await DBOS.runStep(async () => request.attemptId, {
      name: unknownOutcomeReadyStepName(request.attemptId),
    });
    const resolution = parseUnknownResolutionDirective(
      await this.receive(unknownResolutionTopic(request.attemptId)),
    );
    return parseUnknownResolutionDirective(
      await DBOS.runStep(async () => resolution, {
        name: unknownOutcomeResolutionStepName(request.attemptId),
      }),
    );
  }

  async finish(): Promise<void> {
    await this.send({ kind: 'scopeFinish', workflowId: this.workflowId() });
    await this.receiveReply();
  }

  async admitScope(workflowId: string): Promise<ScopeStartFenceReply> {
    const requestId = `request:${workflowId}`;
    await this.send({
      kind: 'scopeAdmission',
      requestId,
      workflowId,
      parentWorkflowId: this.workflowId(),
    });
    const reply = parseScopeStartFenceReply(
      await this.receive(scopeAdmissionReplyTopic(workflowId)),
    );
    if (reply.workflowId !== workflowId || reply.requestId !== requestId) {
      throw new Error('Scope admission reply belongs to another workflow.');
    }
    return reply;
  }

  async cancelScopes(workflowIds: readonly string[], joinNodeInstanceId: string): Promise<void> {
    if (workflowIds.length === 0) {
      return;
    }
    await this.send({
      kind: 'scopeCancellation',
      workflowId: this.workflowId(),
      joinNodeInstanceId,
      childWorkflowIds: workflowIds,
    });
    await this.receiveReply();
  }

  async scopeSettled(): Promise<void> {
    await this.send({ kind: 'scopeSettled', workflowId: this.workflowId() });
    parseScopeSettlementAcknowledgement(await this.receive(scopeSettlementTopic));
    const directive = await DBOS.recv(scopeDirectiveTopic, { timeoutSeconds: 0 });
    if (directive !== null) {
      parseScopeDirective(directive);
    }
  }

  private assertContinue(value: unknown): void {
    const directive = parseScopeDirective(value);
    if (directive.kind === 'cancel') {
      throw new ScopeCancellationError('Run scope cancellation was requested.');
    }
    if (directive.kind === 'fail') {
      throw new ScopeFailureFenceError('Run scope was fenced by coordinator failure.');
    }
  }

  private async receiveReply(): Promise<void> {
    const reply = await this.receive(scopeReplyTopic);
    const directive = await DBOS.recv(scopeDirectiveTopic, { timeoutSeconds: 0 });
    if (directive !== null) {
      this.assertContinue(directive);
    }
    this.assertContinue(reply);
  }

  private send(message: RunCoordinatorMessage): Promise<void> {
    return DBOS.send(this.rootWorkflowId, message, runCoordinatorTopic);
  }

  private async receive(topic: string): Promise<unknown> {
    const poll = async (): Promise<
      { readonly received: true; readonly value: unknown } | { readonly received: false }
    > => {
      const response = await DBOS.recv(topic, { timeoutSeconds: orphanHealthCheckSeconds });
      if (response !== null) {
        return { received: true, value: response };
      }
      const rootStatus = await DBOS.getWorkflowStatus(this.rootWorkflowId);
      if (rootStatus === null || !isActiveWorkflowStatus(rootStatus.status)) {
        throw new ScopeCancellationError(
          'Run coordinator terminated before replying to its scope.',
        );
      }
      return { received: false };
    };
    for await (const response of durableOperationLoop(poll)) {
      if (response.received) {
        return response.value;
      }
    }
    throw new Error('Durable coordinator reply loop terminated unexpectedly.');
  }

  private workflowId(): string {
    const workflowId = DBOS.workflowID;
    if (!workflowId?.startsWith('rr:scope:')) {
      throw new Error('Pipeline execution has no DBOS workflow ID.');
    }
    return workflowId;
  }
}
