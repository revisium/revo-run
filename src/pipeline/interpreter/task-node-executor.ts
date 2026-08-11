import type { TaskNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ExecutionBinding } from '../../contracts/run/execution-binding.js';
import { InputResolver } from '../data/input-resolver.js';
import { createAttemptId } from '../identity/execution-identity.js';
import type { ExecuteNodeEffect, PipelineExecutionContext } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import {
  inputResolutionFailedEvent,
  pipelineInvalidStateEvent,
  pipelineNodeEventIdentity,
  type PipelineEventSink,
} from './pipeline-event-sink.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution } from './pipeline-node-result.js';

export class TaskNodeExecutor {
  private readonly executeEffect: ExecuteNodeEffect;
  private readonly events: PipelineEventSink;

  constructor(executeEffect: ExecuteNodeEffect, events: PipelineEventSink) {
    this.executeEffect = executeEffect;
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

    const attemptOrdinal = 1;
    const attemptId = createAttemptId({ nodeInstanceId: identity.nodeInstanceId, attemptOrdinal });
    const request = {
      runId: context.runId,
      ...identity,
      attemptId,
      attemptOrdinal,
      displayPath: runtimePath(context, nodePath),
      pipelineId: context.pipelineId,
      nodePath,
      binding,
      input: input.value,
    } as const;
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
        data: { ...identity, attemptId, attemptOrdinal },
      });
      return continuedExecution('timedOut', runtimePath(context, nodePath));
    }
    if (execution.result.kind === 'inputResolutionFailed') {
      return this.inputResolutionFailed(node, nodePath, context, execution.result.error.code);
    }
    if (execution.result.kind === 'failed') {
      await this.events.write({
        type: 'nodeExecution.failed',
        data: { ...identity, attemptId, attemptOrdinal, errorCode: execution.result.error.code },
      });
      return continuedExecution('failed', runtimePath(context, nodePath));
    }

    await this.events.write({
      type: 'nodeExecution.completed',
      data: { ...identity, attemptId, attemptOrdinal, outcome: execution.result.outcome },
    });
    const output = execution.result.output ?? {};
    context.outputs.set(nodePath, output);
    return continuedExecution(execution.result.outcome, runtimePath(context, nodePath), output);
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
