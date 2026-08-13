import type { ParallelBranchWorkflowV2 } from './parallel-branch-workflow-v2.js';

export class ParallelBranchWorkflowV2Provider {
  private workflow: ParallelBranchWorkflowV2 | undefined;

  register(workflow: ParallelBranchWorkflowV2): void {
    if (this.workflow !== undefined) {
      throw new Error('Parallel branch workflow v2 is already registered.');
    }
    this.workflow = workflow;
  }

  get(): ParallelBranchWorkflowV2 {
    if (this.workflow === undefined) {
      throw new Error('Parallel branch workflow v2 is not registered.');
    }
    return this.workflow;
  }
}
