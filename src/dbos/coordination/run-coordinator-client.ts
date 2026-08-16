import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RecoveryPolicy, RetryPolicy } from '../../contracts/pipeline/task-policy.js';
import type { UnknownResolutionDirective } from '../../contracts/workflow/run-command-workflow.js';
import type {
  RunCoordinatorMessage,
  ScopeStartFenceReply,
} from '../../contracts/workflow/run-coordinator-message.js';
import type {
  InlineScopeOwnershipRegistrar,
  InlineScopeOwnershipRegistration,
} from '../../pipeline/interpreter/inline-scope-ownership-registrar.js';
import type {
  DelayWaitResult,
  HumanGateResolution,
  HumanGateWaitRequest,
} from '../../pipeline/interpreter/interpreter-context.js';
import type {
  PipelineEventDraft,
  PipelineEventSink,
} from '../../pipeline/interpreter/pipeline-event-sink.js';
import {
  parseScopeDirective,
  parseScopeSettlementAcknowledgement,
} from '../../validation/run-command-workflow.validator.js';
import {
  parseExecutionReservation,
  parseScopeStartFenceReply,
} from '../../validation/run-coordinator-message.validator.js';
import {
  runCoordinatorReplyTopic,
  runCoordinatorTopic,
  scopeAdmissionReplyTopic,
  scopeDirectiveTopic,
  scopeReplyTopic,
  scopeSettlementTopic,
} from '../dbos-names.js';
import { runWorkflowId } from '../workflow-id.js';
import { isActiveWorkflowStatus } from '../workflow-status.js';
import { durableOperationLoop } from './durable-operation-loop.js';
import { orphanHealthCheckSeconds } from './orphan-health-check.js';
import { ScopeCancellationError, ScopeFailureFenceError } from './scope-fence-errors.js';
import { ScopeWaitOperations } from './scope-wait-operations.js';

export { ScopeCancellationError, ScopeFailureFenceError };

export class RunCoordinatorClient implements PipelineEventSink, InlineScopeOwnershipRegistrar {
  private readonly rootWorkflowId: string;
  private readonly waitOperations: ScopeWaitOperations;
  private boundarySequence = 0;

  constructor(private readonly runId: string) {
    this.rootWorkflowId = runWorkflowId(runId);
    this.waitOperations = new ScopeWaitOperations({
      workflowId: () => this.workflowId(),
      boundary: () => this.boundary(),
      receive: (topic) => this.receive(topic),
      receiveReply: () => this.receiveReply(),
      send: (message) => this.send(message),
      assertContinue: (value) => this.assertContinue(value),
      assertCoordinatorLive: () => this.assertCoordinatorLive(),
    });
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

  async registerInlineScopeOwnership(
    registration: InlineScopeOwnershipRegistration,
  ): Promise<void> {
    await this.send({
      kind: 'inlineScopeOwnership',
      workflowId: this.workflowId(),
      ...registration,
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

  waitForRetry(request: RunExecutorRequest, delayMs: number): Promise<void> {
    return this.waitOperations.waitForRetry(request, delayMs);
  }

  waitForDelay(durationMs: number): Promise<DelayWaitResult> {
    return this.waitOperations.waitForDelay(durationMs);
  }

  waitForUnknownOutcome(
    request: RunExecutorRequest,
    recovery: RecoveryPolicy,
    retry: RetryPolicy | undefined,
    reconciliationRound: number,
  ): Promise<UnknownResolutionDirective> {
    return this.waitOperations.waitForUnknownOutcome(request, recovery, retry, reconciliationRound);
  }

  waitForHumanGate(request: HumanGateWaitRequest): Promise<HumanGateResolution> {
    return this.waitOperations.waitForHumanGate(request);
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

  private async assertCoordinatorLive(): Promise<void> {
    const rootStatus = await DBOS.getWorkflowStatus(this.rootWorkflowId);
    if (rootStatus === null || !isActiveWorkflowStatus(rootStatus.status)) {
      throw new ScopeCancellationError('Run coordinator terminated before replying to its scope.');
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
      await this.assertCoordinatorLive();
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
