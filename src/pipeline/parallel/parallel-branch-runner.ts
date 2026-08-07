import type { NodeOutput } from '../../contracts/pipeline/node-output.js';
import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
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

export interface ParallelBranchRunner {
  execute(
    branches: readonly ParallelBranch[],
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<readonly ParallelBranchResult[]>;
}
