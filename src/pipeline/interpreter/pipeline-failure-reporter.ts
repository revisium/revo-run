import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { PipelineExecutionContext } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import {
  inputResolutionFailedEvent,
  pipelineInvalidStateEvent,
  type PipelineEventSink,
} from './pipeline-event-sink.js';
import type { FinishedNodeExecutionResult, NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution, terminalExecution } from './pipeline-node-result.js';

/** Projects interpreter failures through the durable event boundary. */
export class PipelineFailureReporter {
  constructor(private readonly events: PipelineEventSink) {}

  async inputResolutionFailed(
    node: PipelineNode,
    context: PipelineExecutionContext,
    nodePath: string,
    errorCode: string,
  ): Promise<NodeExecutionResult> {
    await this.events.write(inputResolutionFailedEvent(node, context, nodePath, errorCode));
    return continuedExecution('failed', runtimePath(context, nodePath));
  }

  async invalidNode(
    node: PipelineNode,
    context: PipelineExecutionContext,
    nodePath: string,
    errorCode: string,
  ): Promise<FinishedNodeExecutionResult> {
    await this.events.write(pipelineInvalidStateEvent(node, context, nodePath, errorCode));
    return terminalExecution({ status: 'failed', outcome: 'invalid' });
  }
}
