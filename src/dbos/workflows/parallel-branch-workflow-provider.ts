import type { ParallelBranchWorkflow } from './parallel-branch-workflow.js';

export class ParallelBranchWorkflowProvider {
  private workflow: ParallelBranchWorkflow | undefined;

  register(workflow: ParallelBranchWorkflow): void {
    if (this.workflow !== undefined) {
      throw new Error('Parallel branch workflow is already registered.');
    }
    this.workflow = workflow;
  }

  get(): ParallelBranchWorkflow {
    if (this.workflow === undefined) {
      throw new Error('Parallel branch workflow is not registered.');
    }
    return this.workflow;
  }
}
