import type { ExecutorInput } from '../../contracts/executor/executor-input.js';
import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { RepeatNode } from '../../contracts/pipeline/pipeline-node.js';
import { InputResolver } from '../data/input-resolver.js';
import type { RepeatIterationRunner } from '../repeat/repeat-iteration-runner.js';
import type { PipelineExecutionContext } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import { pipelineNodeEventIdentity, type PipelineEventSink } from './pipeline-event-sink.js';
import { PipelineFailureReporter } from './pipeline-failure-reporter.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution, terminalExecution } from './pipeline-node-result.js';

export class RepeatNodeExecutor {
  private readonly failures: PipelineFailureReporter;

  constructor(
    private readonly iterations: RepeatIterationRunner,
    private readonly events: PipelineEventSink,
  ) {
    this.failures = new PipelineFailureReporter(events);
  }

  async execute(
    node: RepeatNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const initialInput = new InputResolver(context).resolveMapping(node.initialInput);
    if (!initialInput.resolved) {
      return this.failures.inputResolutionFailed(node, context, nodePath, initialInput.errorCode);
    }
    return this.executeIteration(node, context, nodePath, 1, initialInput.value);
  }

  private async executeIteration(
    node: RepeatNode,
    context: PipelineExecutionContext,
    nodePath: string,
    ordinal: number,
    input: ExecutorInput,
  ): Promise<NodeExecutionResult> {
    const result = await this.iterations.execute({ node, context, nodePath, ordinal, input });
    if (result.kind === 'terminal') {
      return terminalExecution(result.result);
    }
    if (node.completeOn.includes(result.outcome)) {
      return this.finish(node, context, nodePath, 'completed', result.output);
    }
    if (!node.continueOn.includes(result.outcome)) {
      return this.failures.invalidNode(node, context, nodePath, 'unhandled_node_outcome');
    }
    if (ordinal === node.maximumIterations) {
      await this.events.write({
        type: 'repeat.exhausted',
        data: pipelineNodeEventIdentity(node, context, nodePath),
      });
      return this.finish(node, context, nodePath, 'exhausted', result.output);
    }
    const nextInput = new InputResolver({
      ...context,
      iterationInput: input,
      ...(result.output === undefined ? {} : { iterationOutput: result.output }),
    }).resolveMapping(node.nextInput);
    if (!nextInput.resolved) {
      return this.failures.inputResolutionFailed(node, context, nodePath, nextInput.errorCode);
    }
    return this.executeIteration(node, context, nodePath, ordinal + 1, nextInput.value);
  }

  private finish(
    node: RepeatNode,
    context: PipelineExecutionContext,
    nodePath: string,
    outcome: 'completed' | 'exhausted',
    output: NodeOutput | undefined,
  ): NodeExecutionResult {
    if (output !== undefined) {
      context.outputs.set(nodePath, output);
    }
    return continuedExecution(outcome, runtimePath(context, nodePath), output);
  }
}
