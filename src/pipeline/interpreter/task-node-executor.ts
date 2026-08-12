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
} from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import {
  inputResolutionFailedEvent,
  pipelineInvalidStateEvent,
  pipelineNodeEventIdentity,
  type PipelineEventSink,
} from './pipeline-event-sink.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution } from './pipeline-node-result.js';

type ResolvedTaskRequest = Omit<
  RunExecutorRequest,
  'attemptId' | 'attemptOrdinal' | 'displayPath' | 'nodePath' | 'pipelineId' | 'runId'
>;

export class TaskNodeExecutor {
  private readonly executeEffect: ExecuteNodeEffect;
  private readonly waitForRetry: WaitForRetry;
  private readonly events: PipelineEventSink;

  constructor(
    executeEffect: ExecuteNodeEffect,
    waitForRetry: WaitForRetry,
    events: PipelineEventSink,
  ) {
    this.executeEffect = executeEffect;
    this.waitForRetry = waitForRetry;
    this.events = events;
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
      return { kind: 'finished', result: { status: 'failed', outcome: 'invalid' } };
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
    );
  }

  private async executeAttempt(
    node: TaskNode,
    context: PipelineExecutionContext,
    nodePath: string,
    input: ResolvedTaskRequest,
    attemptOrdinal: number,
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
      return { kind: 'finished', result: { status: 'failed', outcome: 'invalid' } };
    }
    if (execution.kind === 'timedOut') {
      await this.events.write({
        type: 'nodeExecution.timedOut',
        data: this.attemptEventIdentity(request),
      });
      return continuedExecution('timedOut', runtimePath(context, nodePath));
    }
    if (execution.result.kind === 'inputResolutionFailed') {
      await this.events.write(
        inputResolutionFailedEvent(node, context, nodePath, execution.result.error.code),
      );
      await this.writeAttemptFailure(request, execution.result.error.code);
      return continuedExecution('failed', runtimePath(context, nodePath));
    }
    if (execution.result.kind === 'failed') {
      await this.writeAttemptFailure(request, execution.result.error.code);
      if (this.shouldRetry(node.retry, attemptOrdinal, execution.result.error.code)) {
        await this.waitForRetry(this.retryDelay(node.retry, attemptOrdinal));
        return this.executeAttempt(node, context, nodePath, input, attemptOrdinal + 1);
      }
      return continuedExecution('failed', runtimePath(context, nodePath));
    }

    await this.events.write({
      type: 'nodeExecution.completed',
      data: { ...this.attemptEventIdentity(request), outcome: execution.result.outcome },
    });
    const output = execution.result.output ?? {};
    context.outputs.set(nodePath, output);
    return continuedExecution(execution.result.outcome, runtimePath(context, nodePath), output);
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
