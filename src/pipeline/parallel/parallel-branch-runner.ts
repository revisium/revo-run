import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { ParallelNode, PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { TerminalWorkflowResult } from '../../contracts/workflow/terminal-workflow-result.js';
import type { PipelineExecutionContext } from '../interpreter/interpreter-context.js';

export interface ParallelBranch {
  readonly key: string;
  readonly node: PipelineNode;
}

export interface ParallelBranchResult {
  readonly key: string;
  readonly outcome: string;
  readonly outputs: readonly (readonly [string, NodeOutput])[];
}

export type ParallelExecutionResult =
  | {
      readonly kind: 'continued';
      readonly outcome: 'completed' | 'failed';
      readonly eligibleResults: readonly ParallelBranchResult[];
    }
  | { readonly kind: 'terminal'; readonly result: TerminalWorkflowResult };

export interface ParallelBranchRunner {
  execute(
    node: ParallelNode,
    context: PipelineExecutionContext,
    nodePath: string,
  ): Promise<ParallelExecutionResult>;
}
