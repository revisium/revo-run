import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { ConsensusNode } from '../../contracts/pipeline/pipeline-node.js';
import type { AcceptedConsensusVote } from '../../contracts/workflow/consensus-verdict.js';
import type { ConsensusExecutionPorts } from './consensus-execution-ports.js';
import type { PipelineExecutionContext } from './interpreter-context.js';
import { runtimePath } from './node-path.js';
import type { NodeExecutionResult } from './pipeline-node-result.js';
import { continuedExecution, terminalExecution } from './pipeline-node-result.js';

const aggregatedVotes = (
  authoredIds: readonly string[],
  accepted: readonly AcceptedConsensusVote[],
): NodeOutput => {
  const byId = new Map(
    accepted.map((entry) => [
      entry.participantId,
      { vote: entry.vote, executionId: entry.executionId },
    ]),
  );
  const value: Record<string, { readonly vote: string; readonly executionId: string }> = {};
  for (const id of authoredIds) {
    const entry = byId.get(id);
    if (entry !== undefined) {
      value[id] = entry;
    }
  }
  return { votes: { kind: 'json', value } };
};

export class ConsensusNodeExecutor {
  constructor(private readonly ports: ConsensusExecutionPorts) {}

  async execute(
    node: ConsensusNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<NodeExecutionResult> {
    const resolution = await this.ports.runner.execute(node, context, nodePath, this.ports.wait);
    if (resolution.kind === 'cancel') {
      return terminalExecution({ status: 'cancelled', outcome: 'cancelled' });
    }
    if (resolution.kind === 'fail') {
      return terminalExecution({ status: 'failed', outcome: 'event_budget_exceeded' });
    }
    return continuedExecution(
      resolution.verdict.verdict,
      runtimePath(context, nodePath),
      aggregatedVotes(Object.keys(node.participants), resolution.verdict.acceptedVotes),
    );
  }
}
