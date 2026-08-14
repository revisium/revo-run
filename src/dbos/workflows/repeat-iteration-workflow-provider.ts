import type { RepeatIterationWorkflow } from './repeat-iteration-workflow.js';

export class RepeatIterationWorkflowProvider {
  private workflow: RepeatIterationWorkflow | undefined;

  register(workflow: RepeatIterationWorkflow): void {
    if (this.workflow !== undefined) {
      throw new Error('Repeat iteration workflow is already registered.');
    }
    this.workflow = workflow;
  }

  get(): RepeatIterationWorkflow {
    if (this.workflow === undefined) {
      throw new Error('Repeat iteration workflow is not registered.');
    }
    return this.workflow;
  }
}
