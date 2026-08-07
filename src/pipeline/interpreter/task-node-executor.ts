import type { TaskNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ExecutionBinding } from '../../contracts/run/execution-binding.js';
import { InputResolver } from '../data/input-resolver.js';
import type { ExecuteNodeEffect, PipelineExecutionContext } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import type { PipelineEventSink } from './pipeline-event-sink.js';
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
    const input = new InputResolver(context).resolveMapping(node.input);
    if (!input.resolved) {
      return this.inputResolutionFailed(context, nodePath, input.errorCode);
    }

    const binding = this.bindingFor(context.plan.bindings, context.pipelineId, nodePath);
    if (binding === undefined) {
      await this.events.write('pipeline.invalidState', {
        path: runtimePath(context, nodePath),
        errorCode: 'executor_binding_not_found',
      });
      return { kind: 'finished', result: { status: 'failed', outcome: 'invalid' } };
    }

    const request = {
      executionId: `${context.runId}:${runtimePath(context, nodePath)}:1`,
      runId: context.runId,
      path: runtimePath(context, nodePath),
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
      await this.events.write('pipeline.invalidState', {
        path: runtimePath(context, nodePath),
        errorCode: 'maximum_total_node_executions_exceeded',
      });
      return { kind: 'finished', result: { status: 'failed', outcome: 'invalid' } };
    }
    if (execution.kind === 'timedOut') {
      await this.events.write('nodeExecution.timedOut', {
        path: runtimePath(context, nodePath),
        errorCode: 'execution_timed_out',
      });
      return continuedExecution('timedOut', runtimePath(context, nodePath));
    }
    if (execution.result.kind === 'inputResolutionFailed') {
      return this.inputResolutionFailed(context, nodePath, execution.result.error.code);
    }
    if (execution.result.kind === 'failed') {
      return continuedExecution('failed', runtimePath(context, nodePath));
    }

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
    context: PipelineExecutionContext,
    nodePath: string,
    errorCode: string,
  ): Promise<NodeExecutionResult> {
    await this.events.write('inputResolution.failed', {
      path: runtimePath(context, nodePath),
      errorCode,
    });
    return continuedExecution('failed', runtimePath(context, nodePath));
  }
}
