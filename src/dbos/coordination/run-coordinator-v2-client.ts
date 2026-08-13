import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RecoveryPolicy } from '../../contracts/pipeline/task-policy.js';
import type { RetryPolicy } from '../../contracts/pipeline/task-policy.js';
import type { UnknownResolutionDirective } from '../../contracts/workflow/run-command-workflow.js';
import type { RunCoordinatorV2Message } from '../../contracts/workflow/run-coordinator-v2-message.js';
import type { ExecuteNodeEffect } from '../../pipeline/interpreter/interpreter-context.js';
import type {
  PipelineEventDraft,
  PipelineEventSink,
} from '../../pipeline/interpreter/pipeline-event-sink.js';
import {
  parseScopeDirective,
  parseScopeSettlementAcknowledgement,
  parseUnknownResolutionDirective,
} from '../../validation/run-command-workflow.validator.js';
import { parseExecutionReservationV2 } from '../../validation/run-coordinator-v2-message.validator.js';
import {
  runCoordinatorReplyTopic,
  runCoordinatorV2Topic,
  retryBackoffStepName,
  scopeDirectiveV2Topic,
  scopeReplyV2Topic,
  scopeSettlementV2Topic,
  unknownResolutionV2Topic,
  unknownOutcomeReadyStepName,
  unknownOutcomeResolutionStepName,
} from '../dbos-names.js';
import type { NodeExecutionStepV2 } from '../steps/node-execution-step-v2.js';
import { runWorkflowId } from '../workflow-id.js';
import { isActiveWorkflowStatus } from '../workflow-status.js';
import { durableOperationLoop } from './durable-operation-loop.js';
import { orphanHealthCheckSeconds } from './orphan-health-check.js';

export class ScopeCancellationError extends Error {}

export class ScopeFailureFenceError extends Error {}

export class RunCoordinatorV2Client implements PipelineEventSink {
  private readonly runId: string;
  private readonly rootWorkflowId: string;
  private boundarySequence = 0;

  constructor(runId: string) {
    this.runId = runId;
    this.rootWorkflowId = runWorkflowId(runId);
  }

  async ready(parentWorkflowId: string): Promise<void> {
    await this.send({
      kind: 'scopeReady',
      workflowId: this.workflowId(),
      parentWorkflowId,
    });
    await this.receiveReply();
  }

  async write(event: PipelineEventDraft): Promise<void> {
    await this.send({ kind: 'event', workflowId: this.workflowId(), event });
    await this.receiveReply();
  }

  executionStep(step: NodeExecutionStepV2): ExecuteNodeEffect {
    return async (request, timeoutMs, recovery, nextReconciliationRound, permitCommandId) => {
      if (!(await this.reserveExecution(request, permitCommandId))) {
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
      const result = await step.executeWithRecoveryFence(
        request,
        timeoutMs,
        recovery,
        nextReconciliationRound,
        () => this.boundary(),
      );
      return result;
    };
  }

  async waitForRetry(request: RunExecutorRequest, delayMs: number): Promise<void> {
    await DBOS.runStep(async () => ({ attemptId: request.attemptId, delayMs }), {
      name: retryBackoffStepName(request.attemptId),
    });
    const response = await DBOS.recv(scopeDirectiveV2Topic, {
      timeoutSeconds: delayMs / 1_000,
    });
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
      await this.receive(unknownResolutionV2Topic(request.attemptId)),
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

  async registerScope<Value>(workflowId: string, startScope: () => Promise<Value>): Promise<Value> {
    await this.send({
      kind: 'scopeRegistered',
      workflowId,
      parentWorkflowId: this.workflowId(),
    });
    const scope = await startScope();
    await this.receiveReply();
    return scope;
  }

  async scopeSettled(): Promise<void> {
    await this.send({ kind: 'scopeSettled', workflowId: this.workflowId() });
    parseScopeSettlementAcknowledgement(await this.receive(scopeSettlementV2Topic));
    const directive = await DBOS.recv(scopeDirectiveV2Topic, { timeoutSeconds: 0 });
    if (directive !== null) {
      parseScopeDirective(directive);
    }
  }

  private async boundary(): Promise<void> {
    this.boundarySequence += 1;
    await this.send({
      kind: 'scopeBoundary',
      workflowId: this.workflowId(),
      boundaryId: `boundary-${this.boundarySequence}`,
    });
    await this.receiveReply();
  }

  private async reserveExecution(
    request: RunExecutorRequest,
    permitCommandId: string | undefined,
  ): Promise<boolean> {
    await this.send({
      kind: 'reserveExecution',
      attemptId: request.attemptId,
      replyWorkflowId: this.workflowId(),
      ...(permitCommandId === undefined ? {} : { permitCommandId }),
    });
    const reservation = parseExecutionReservationV2(await this.receive(runCoordinatorReplyTopic));
    if (reservation.attemptId !== request.attemptId) {
      throw new Error('Run execution received a reservation for another execution.');
    }
    return reservation.granted;
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
    const reply = await this.receive(scopeReplyV2Topic);
    const directive = await DBOS.recv(scopeDirectiveV2Topic, { timeoutSeconds: 0 });
    if (directive !== null) {
      this.assertContinue(directive);
    }
    this.assertContinue(reply);
  }

  private send(message: RunCoordinatorV2Message): Promise<void> {
    return DBOS.send(this.rootWorkflowId, message, runCoordinatorV2Topic);
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
    if (workflowId === undefined || !workflowId.startsWith('rr:scope:v2:')) {
      throw new Error('Pipeline execution has no v2 DBOS workflow ID.');
    }
    return workflowId;
  }
}
