import type { ParallelNode } from '../../contracts/pipeline/pipeline-node.js';
import type { PipelineExecutionContext } from '../interpreter/interpreter-context.js';
import { runtimePath } from '../interpreter/node-path.js';
import type { PipelineEventSink } from '../interpreter/pipeline-event-sink.js';
import type { NodeExecutionResult } from '../interpreter/pipeline-node-result.js';
import { continuedExecution } from '../interpreter/pipeline-node-result.js';
import type { ParallelBranchResult, ParallelBranchRunner } from './parallel-branch-runner.js';

const joinSucceeded = (node: ParallelNode, branches: readonly ParallelBranchResult[]): boolean => {
  const successful = branches.filter(({ outcome }) =>
    node.join.successfulOutcomes.includes(outcome),
  ).length;

  switch (node.join.kind) {
    case 'all':
      return successful === branches.length;
    case 'any':
      return successful > 0;
    case 'threshold':
      return successful >= node.join.count;
  }

  node.join satisfies never;
  return node.join;
};

export class ParallelNodeExecutor {
  private readonly branches: ParallelBranchRunner;
  private readonly events: PipelineEventSink;

  constructor(branches: ParallelBranchRunner, events: PipelineEventSink) {
    this.branches = branches;
    this.events = events;
  }

  async execute(
    node: ParallelNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const path = runtimePath(context, nodePath);
    if (node.join.remaining === 'cancel') {
      await this.events.write('pipeline.invalidState', {
        path,
        errorCode: 'parallel_cancel_not_implemented',
      });
      return { kind: 'finished', result: { status: 'failed', outcome: 'invalid' } };
    }

    const results = await this.branches.execute(
      Object.entries(node.branches).map(([key, branch]) => ({ key, node: branch })),
      context,
      nodePath,
    );
    this.mergeOutputs(context, results);

    const outcome = joinSucceeded(node, results) ? 'completed' : 'failed';
    if (outcome === 'failed') {
      await this.events.write('parallel.joinFailed', { path });
    }

    return continuedExecution(outcome, path);
  }

  private mergeOutputs(
    context: PipelineExecutionContext,
    branches: readonly ParallelBranchResult[],
  ): void {
    for (const branch of branches) {
      for (const [path, output] of branch.outputs) {
        context.outputs.set(path, output);
      }
    }
  }
}
