import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RecoveryPolicy, RetryPolicy } from '../../contracts/pipeline/task-policy.js';
import type {
  HumanGateResolutionDirective,
  UnknownResolutionDirective,
} from '../../contracts/workflow/run-command-workflow.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import type {
  DelayWaitResult,
  HumanGateResolution,
  HumanGateWaitRequest,
} from '../../pipeline/interpreter/interpreter-context.js';
import {
  parseHumanGateResolutionDirective,
  parseScopeDirective,
  parseUnknownResolutionDirective,
} from '../../validation/run-command-workflow.validator.js';
import {
  retryBackoffStepName,
  scopeDirectiveTopic,
  unknownOutcomeReadyStepName,
  unknownOutcomeResolutionStepName,
  unknownResolutionTopic,
} from '../dbos-names.js';
import {
  humanGateResolutionStepName,
  humanGateResolutionTopic,
  humanGateWaitingStepName,
} from '../human-gate-names.js';
import { ScopeCancellationError, ScopeFailureFenceError } from './scope-fence-errors.js';

/** The scope-side primitives every durable wait is built from; owned by RunCoordinatorClient. */
export interface ScopeWaitPrimitives {
  workflowId(): string;
  boundary(): Promise<void>;
  receive(topic: string): Promise<unknown>;
  receiveReply(): Promise<void>;
  send(message: RunCoordinatorMessage): Promise<void>;
  assertContinue(value: unknown): void;
  assertCoordinatorLive(): Promise<void>;
}

const toGateResolution = (directive: HumanGateResolutionDirective): HumanGateResolution => {
  switch (directive.kind) {
    case 'answered':
      return { kind: 'answered', answer: directive.answer, commandIds: directive.commandIds };
    case 'conflict':
      return { kind: 'conflict' };
    case 'timedOut':
      return { kind: 'timedOut' };
    case 'cancel':
      return { kind: 'cancel' };
    case 'fail':
      return { kind: 'fail' };
  }
  directive satisfies never;
  return directive;
};

/**
 * Durable-wait capability shared by every node kind that parks a scope on a coordinator-owned
 * topic: retries, delays, unknown outcomes, and human gates. Extracted from RunCoordinatorClient
 * to keep that file's scope-to-coordinator messaging and reply discipline under the 300-line
 * review signal (decision D-09).
 */
export class ScopeWaitOperations {
  constructor(private readonly scope: ScopeWaitPrimitives) {}

  async waitForRetry(request: RunExecutorRequest, delayMs: number): Promise<void> {
    await DBOS.runStep(async () => ({ attemptId: request.attemptId, delayMs }), {
      name: retryBackoffStepName(request.attemptId),
    });
    const response = await DBOS.recv(scopeDirectiveTopic, { timeoutSeconds: delayMs / 1_000 });
    if (response !== null) {
      this.scope.assertContinue(response);
    }
    await this.scope.boundary();
  }

  async waitForDelay(durationMs: number): Promise<DelayWaitResult> {
    const response = await DBOS.recv(scopeDirectiveTopic, {
      timeoutSeconds: durationMs / 1_000,
    });
    if (response !== null) {
      const directive = parseScopeDirective(response);
      if (directive.kind === 'cancel') {
        return 'cancelled';
      }
      if (directive.kind === 'fail') {
        return 'failed';
      }
      return 'elapsed';
    }
    try {
      await this.scope.boundary();
      return 'elapsed';
    } catch (error) {
      if (error instanceof ScopeCancellationError) {
        return 'cancelled';
      }
      if (error instanceof ScopeFailureFenceError) {
        return 'failed';
      }
      throw error;
    }
  }

  async waitForUnknownOutcome(
    request: RunExecutorRequest,
    recovery: RecoveryPolicy,
    retry: RetryPolicy | undefined,
    reconciliationRound: number,
  ): Promise<UnknownResolutionDirective> {
    await this.scope.send({
      kind: 'unknownOutcomeWaiting',
      workflowId: this.scope.workflowId(),
      request,
      attemptOrdinal: request.attemptOrdinal,
      reconciliationRound,
      recovery,
      ...(retry === undefined ? {} : { retry }),
    });
    await this.scope.receiveReply();
    await DBOS.runStep(async () => request.attemptId, {
      name: unknownOutcomeReadyStepName(request.attemptId),
    });
    const resolution = parseUnknownResolutionDirective(
      await this.scope.receive(unknownResolutionTopic(request.attemptId)),
    );
    return parseUnknownResolutionDirective(
      await DBOS.runStep(async () => resolution, {
        name: unknownOutcomeResolutionStepName(request.attemptId),
      }),
    );
  }

  async waitForHumanGate(request: HumanGateWaitRequest): Promise<HumanGateResolution> {
    await this.scope.send({
      kind: 'humanGateWaiting',
      workflowId: this.scope.workflowId(),
      gateInstanceId: request.gateInstanceId,
      scopeId: request.scopeId,
      authoredNodeId: request.authoredNodeId,
      answers: request.answers,
      decision: request.decision,
      ...(request.eligibleGroup === undefined ? {} : { eligibleGroup: request.eligibleGroup }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    await this.scope.receiveReply();
    await DBOS.runStep(async () => request.gateInstanceId, {
      name: humanGateWaitingStepName(request.gateInstanceId),
    });
    return this.parkForGateResolution(request.gateInstanceId, request.timeoutMs);
  }

  private async parkForGateResolution(
    gateInstanceId: string,
    timeoutMs: number | undefined,
  ): Promise<HumanGateResolution> {
    const topic = humanGateResolutionTopic(gateInstanceId);
    for (;;) {
      if (timeoutMs === undefined) {
        const resolution = parseHumanGateResolutionDirective(await this.scope.receive(topic));
        return this.checkpointGateResolution(gateInstanceId, resolution);
      }
      const response = await DBOS.recv(topic, { timeoutSeconds: timeoutMs / 1_000 });
      if (response !== null) {
        return this.checkpointGateResolution(
          gateInstanceId,
          parseHumanGateResolutionDirective(response),
        );
      }
      // Same liveness probe as receive(): a dead root must not re-arm the deadline forever.
      await this.scope.assertCoordinatorLive();
      // The deadline is a proposal, not a decision (D-05): this send is deliberately reply-free, so
      // no receiveReply() call follows it, unlike every other scope-originated send.
      await this.scope.send({
        kind: 'humanGateDeadlineReached',
        workflowId: this.scope.workflowId(),
        gateInstanceId,
      });
    }
  }

  private async checkpointGateResolution(
    gateInstanceId: string,
    resolution: HumanGateResolutionDirective,
  ): Promise<HumanGateResolution> {
    const checkpointed = parseHumanGateResolutionDirective(
      await DBOS.runStep(async () => resolution, {
        name: humanGateResolutionStepName(gateInstanceId),
      }),
    );
    return toGateResolution(checkpointed);
  }
}
