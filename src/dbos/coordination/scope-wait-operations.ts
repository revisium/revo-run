import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { RecoveryPolicy, RetryPolicy } from '../../contracts/pipeline/task-policy.js';
import type { ConsensusResolutionDirective } from '../../contracts/workflow/consensus-resolution.js';
import type {
  HumanGateResolutionDirective,
  UnknownResolutionDirective,
} from '../../contracts/workflow/run-command-workflow.js';
import type { RunCoordinatorMessage } from '../../contracts/workflow/run-coordinator-message.js';
import type { ConsensusWaitRequest } from '../../pipeline/consensus/consensus-participant-runner.js';
import type { DelayWaitResult } from '../../pipeline/interpreter/delay-execution-ports.js';
import type {
  HumanGateResolution,
  HumanGateWaitRequest,
} from '../../pipeline/interpreter/human-gate-ports.js';
import { parseConsensusResolutionDirective } from '../../validation/consensus-resolution.validator.js';
import { parseDurableConsensusVerdict } from '../../validation/consensus-verdict.validator.js';
import {
  parseHumanGateResolutionDirective,
  parseScopeDirective,
  parseUnknownResolutionDirective,
} from '../../validation/run-command-workflow.validator.js';
import {
  consensusResolutionTopic,
  consensusVerdictStepName,
  consensusWaitingStepName,
} from '../consensus/consensus-names.js';
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

  async registerConsensusWaiting(request: ConsensusWaitRequest): Promise<void> {
    await this.scope.send({
      kind: 'consensusWaiting',
      workflowId: this.scope.workflowId(),
      consensusNodeInstanceId: request.consensusNodeInstanceId,
      scopeId: request.scopeId,
      authoredNodeId: request.authoredNodeId,
      pipelineId: request.pipelineId,
      nodePath: request.nodePath,
      participantIds: request.participantIds,
      participantInstances: request.participantInstances.map(
        ({ workflowId: _workflowId, ...identity }) => identity,
      ),
      policy: request.policy,
      remaining: request.remaining,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    await this.scope.receiveReply();
    await DBOS.runStep(async () => request.consensusNodeInstanceId, {
      name: consensusWaitingStepName(request.consensusNodeInstanceId),
    });
  }

  async waitForConsensusResolution(
    request: ConsensusWaitRequest,
  ): Promise<ConsensusResolutionDirective> {
    return this.parkForConsensusResolution(request);
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

  private async parkForConsensusResolution(
    request: ConsensusWaitRequest,
  ): Promise<ConsensusResolutionDirective> {
    const topic = consensusResolutionTopic(request.consensusNodeInstanceId);
    for (;;) {
      if (request.timeoutMs === undefined) {
        return this.checkpointConsensusResolution(
          request.consensusNodeInstanceId,
          parseConsensusResolutionDirective(await this.scope.receive(topic)),
        );
      }
      const response = await DBOS.recv(topic, { timeoutSeconds: request.timeoutMs / 1_000 });
      if (response !== null) {
        return this.checkpointConsensusResolution(
          request.consensusNodeInstanceId,
          parseConsensusResolutionDirective(response),
        );
      }
      await this.scope.assertCoordinatorLive();
      await this.scope.send({
        kind: 'consensusDeadlineReached',
        workflowId: this.scope.workflowId(),
        consensusNodeInstanceId: request.consensusNodeInstanceId,
      });
    }
  }

  private async checkpointConsensusResolution(
    nodeInstanceId: string,
    resolution: ConsensusResolutionDirective,
  ): Promise<ConsensusResolutionDirective> {
    const payload = resolution.kind === 'decided' ? resolution.verdict : resolution;
    const checkpointed = await DBOS.runStep(async () => payload, {
      name: consensusVerdictStepName(nodeInstanceId),
    });
    if (resolution.kind === 'decided') {
      return { kind: 'decided', verdict: parseDurableConsensusVerdict(checkpointed) };
    }
    return parseConsensusResolutionDirective(checkpointed);
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
