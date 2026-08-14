import type { RunExecutorRequest } from '../../contracts/executor/run-executor.js';
import type { TaskNode } from '../../contracts/pipeline/pipeline-node.js';
import type { RetryPolicy } from '../../contracts/pipeline/task-policy.js';
import type { ExecutionBinding } from '../../contracts/run/execution-binding.js';
import { InputResolver } from '../data/input-resolver.js';
import { createAttemptId } from '../identity/execution-identity.js';
import type {
  ExecuteNodeEffect,
  PipelineExecutionContext,
  WaitForRetry,
  WaitForUnknownOutcome,
} from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import {
  inputResolutionFailedEvent,
  pipelineInvalidStateEvent,
  pipelineNodeEventIdentity,
  type PipelineEventSink,
} from './pipeline-event-sink.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution, terminalExecution } from './pipeline-node-result.js';
import { resolveUnknownOutcome } from './unknown-outcome-resolver.js';

type ResolvedTaskRequest = Omit<
  RunExecutorRequest,
  'attemptId' | 'attemptOrdinal' | 'displayPath' | 'nodePath' | 'pipelineId' | 'runId'
>;

const unsupportedRecovery = {
  reconciliation: 'unsupported',
  unknownOutcome: 'fail',
} as const;

export class TaskNodeExecutor {
  private readonly executeEffect: ExecuteNodeEffect;
  private readonly waitForRetry: WaitForRetry;
  private readonly events: PipelineEventSink;
  private readonly waitForUnknownOutcome: WaitForUnknownOutcome;

  constructor(
    executeEffect: ExecuteNodeEffect,
    waitForRetry: WaitForRetry,
    events: PipelineEventSink,
    waitForUnknownOutcome: WaitForUnknownOutcome,
  ) {
    this.executeEffect = executeEffect;
    this.waitForRetry = waitForRetry;
    this.events = events;
    this.waitForUnknownOutcome = waitForUnknownOutcome;
  }

  async execute(
    node: TaskNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const identity = pipelineNodeEventIdentity(node, context, nodePath);
    const input = new InputResolver(context).resolveMapping(node.input);
    if (!input.resolved) {
      return this.inputResolutionFailed(node, nodePath, context, input.errorCode);
    }

    const binding = this.bindingFor(context.plan.bindings, context.pipelineId, nodePath);
    if (binding === undefined) {
      await this.events.write(
        pipelineInvalidStateEvent(node, context, nodePath, 'executor_binding_not_found'),
      );
      return terminalExecution({ status: 'failed', outcome: 'invalid' });
    }

    return this.executeAttempt(
      node,
      context,
      nodePath,
      {
        ...identity,
        binding,
        input: input.value,
      },
      1,
      1,
    );
  }

  private async executeAttempt(
    node: TaskNode,
    context: PipelineExecutionContext,
    nodePath: string,
    input: ResolvedTaskRequest,
    attemptOrdinal: number,
    nextReconciliationRound: number,
    permitCommandId?: string,
  ): Promise<NodeExecutionResult> {
    const attemptId = createAttemptId({
      nodeInstanceId: input.nodeInstanceId,
      attemptOrdinal,
    });
    const request: RunExecutorRequest = {
      runId: context.runId,
      ...input,
      attemptId,
      attemptOrdinal,
      displayPath: runtimePath(context, nodePath),
      pipelineId: context.pipelineId,
      nodePath,
    };
    const execution = await this.executeEffect(
      request,
      node.timeoutMs ?? context.plan.policies.defaultTaskTimeoutMs,
      node.recovery ?? unsupportedRecovery,
      nextReconciliationRound,
      permitCommandId,
    );

    if (execution.kind === 'executionLimitExceeded') {
      await this.events.write(
        pipelineInvalidStateEvent(
          node,
          context,
          nodePath,
          'maximum_total_node_executions_exceeded',
        ),
      );
      return terminalExecution({ status: 'failed', outcome: 'invalid' });
    }
    if (execution.kind === 'cancelled') {
      return terminalExecution({ status: 'cancelled', outcome: 'cancelled' });
    }
    if (execution.kind === 'timedOut') {
      await this.events.write({
        type: 'nodeExecution.timedOut',
        data: this.attemptEventIdentity(request),
      });
      return continuedExecution('timedOut', runtimePath(context, nodePath));
    }
    if (execution.kind === 'outcomeUnknown') {
      if (
        node.recovery?.reconciliation === 'required' &&
        node.recovery.unknownOutcome === 'requireHumanResolution'
      ) {
        return resolveUnknownOutcome({
          waitForResolution: this.waitForUnknownOutcome,
          node,
          context,
          nodePath,
          request,
          reconciliationRound: execution.reconciliationRound,
          fail: async (errorCode) => {
            await this.writeAttemptFailure(request, errorCode);
            return continuedExecution('failed', runtimePath(context, nodePath));
          },
          retry: async (ordinal, round, commandId) =>
            this.executeAttempt(node, context, nodePath, input, ordinal, round, commandId),
        });
      }
      await this.writeAttemptFailure(request, 'outcome_unknown');
      return continuedExecution('failed', runtimePath(context, nodePath));
    }
    if (execution.kind === 'recoveryExhausted') {
      await this.events.write({
        type: 'nodeExecution.recoveryExhausted',
        data: {
          ...this.attemptEventIdentity(request),
          reconciliationRound: execution.reconciliationRound,
        },
      });
      await this.writeAttemptFailure(request, 'recovery_exhausted');
      return continuedExecution('failed', runtimePath(context, nodePath));
    }
    if (execution.kind === 'effectNotFound') {
      await this.writeAttemptFailure(request, 'effect_not_found');
      return this.executeAttempt(
        node,
        context,
        nodePath,
        input,
        attemptOrdinal + 1,
        execution.nextReconciliationRound,
      );
    }
    if (execution.execution.result.kind === 'inputResolutionFailed') {
      await this.events.write(
        inputResolutionFailedEvent(node, context, nodePath, execution.execution.result.error.code),
      );
      await this.writeAttemptFailure(request, execution.execution.result.error.code);
      return continuedExecution('failed', runtimePath(context, nodePath));
    }
    if (execution.execution.result.kind === 'failed') {
      await this.writeAttemptFailure(request, execution.execution.result.error.code);
      if (this.shouldRetry(node.retry, attemptOrdinal, execution.execution.result.error.code)) {
        await this.waitForRetry(request, this.retryDelay(node.retry, attemptOrdinal));
        return this.executeAttempt(
          node,
          context,
          nodePath,
          input,
          attemptOrdinal + 1,
          execution.nextReconciliationRound,
        );
      }
      return continuedExecution('failed', runtimePath(context, nodePath));
    }

    await this.events.write({
      type: 'nodeExecution.completed',
      data: {
        ...this.attemptEventIdentity(request),
        outcome: execution.execution.result.outcome,
      },
    });
    const output = execution.execution.result.output;
    if (output !== undefined) {
      context.outputs.set(nodePath, output);
    }
    return continuedExecution(
      execution.execution.result.outcome,
      runtimePath(context, nodePath),
      output,
    );
  }

  private async writeAttemptFailure(request: RunExecutorRequest, errorCode: string): Promise<void> {
    await this.events.write({
      type: 'nodeExecution.failed',
      data: { ...this.attemptEventIdentity(request), errorCode },
    });
  }

  private attemptEventIdentity(request: RunExecutorRequest) {
    return {
      scopeId: request.scopeId,
      authoredNodeId: request.authoredNodeId,
      nodeInstanceId: request.nodeInstanceId,
      attemptId: request.attemptId,
      attemptOrdinal: request.attemptOrdinal,
    };
  }

  private shouldRetry(
    policy: RetryPolicy | undefined,
    attemptOrdinal: number,
    errorCode: string,
  ): policy is RetryPolicy {
    return (
      policy !== undefined &&
      attemptOrdinal < policy.maximumAttempts &&
      policy.retryableErrorCodes.includes(errorCode)
    );
  }

  private retryDelay(policy: RetryPolicy, attemptOrdinal: number): number {
    if (policy.backoff.kind === 'constant') {
      return policy.backoff.delayMs;
    }
    return Math.min(
      policy.backoff.initialDelayMs * 2 ** (attemptOrdinal - 1),
      policy.backoff.maximumDelayMs,
    );
  }

  private bindingFor(
    bindings: readonly ExecutionBinding[],
    pipelineId: string,
    nodePath: string,
  ): ExecutionBinding | undefined {
    return bindings.find(
      ({ target }) => target.pipelineId === pipelineId && target.nodePath === nodePath,
    );
  }

  private async inputResolutionFailed(
    node: TaskNode,
    nodePath: string,
    context: PipelineExecutionContext,
    errorCode: string,
  ): Promise<NodeExecutionResult> {
    await this.events.write(inputResolutionFailedEvent(node, context, nodePath, errorCode));
    return continuedExecution('failed', runtimePath(context, nodePath));
  }
}
