import type { DelayNode } from '../../contracts/pipeline/pipeline-node.js';
import type { PipelineExecutionContext, WaitForDelay } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import { pipelineNodeEventIdentity, type PipelineEventSink } from './pipeline-event-sink.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution, terminalExecution } from './pipeline-node-result.js';

export class DelayNodeExecutor {
  constructor(
    private readonly wait: WaitForDelay,
    private readonly events: PipelineEventSink,
  ) {}

  async execute(
    node: DelayNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const result = await this.wait(node.durationMs);
    if (result === 'elapsed') {
      return continuedExecution('completed', runtimePath(context, nodePath));
    }
    if (result === 'failed') {
      return terminalExecution({ status: 'failed', outcome: 'event_budget_exceeded' });
    }
    await this.events.write({
      type: 'delay.cancelled',
      data: pipelineNodeEventIdentity(node, context, nodePath),
    });
    return terminalExecution({ status: 'cancelled', outcome: 'cancelled' });
  }
}
