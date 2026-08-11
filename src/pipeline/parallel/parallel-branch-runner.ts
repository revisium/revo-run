import type { PipelineNode } from '../../contracts/pipeline/pipeline-node.js';
import type { ParallelBranchResult } from '../../contracts/workflow/parallel-branch-result.js';
import type { PipelineExecutionContext } from '../interpreter/interpreter-context.js';

export interface ParallelBranch {
  readonly key: string;
  readonly node: PipelineNode;
}

export interface ParallelBranchRunner {
  execute(
    branches: readonly ParallelBranch[],
    context: PipelineExecutionContext,
    parentPath: string,
  ): Promise<readonly ParallelBranchResult[]>;
}

export type { ParallelBranchResult } from '../../contracts/workflow/parallel-branch-result.js';
