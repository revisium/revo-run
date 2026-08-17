import type { ParallelNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ParallelBranchRunner } from '../parallel/parallel-branch-runner.js';
import type { PipelineExecutionContext } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import { pipelineNodeEventIdentity, type PipelineEventSink } from './pipeline-event-sink.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution, terminalExecution } from './pipeline-node-result.js';

export class ParallelNodeExecutor {
  constructor(
    private readonly branches: ParallelBranchRunner,
    private readonly events: PipelineEventSink,
  ) {}

  async execute(
    node: ParallelNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const result = await this.branches.execute(node, context, nodePath);
    if (result.kind === 'terminal') {
      return terminalExecution(result.result);
    }
    for (const branch of result.eligibleResults) {
      for (const [path, output] of branch.outputs) {
        context.outputs.set(path, output);
      }
    }
    if (result.outcome === 'failed') {
      await this.events.write({
        type: 'parallel.joinFailed',
        data: pipelineNodeEventIdentity(node, context, nodePath),
      });
    }
    return continuedExecution(result.outcome, runtimePath(context, nodePath));
  }
}
