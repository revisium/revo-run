import type { MapItemWorkflow } from './map-item-workflow.js';

export class MapItemWorkflowProvider {
  private workflow: MapItemWorkflow | undefined;

  register(workflow: MapItemWorkflow): void {
    if (this.workflow !== undefined) {
      throw new Error('Map item workflow is already registered.');
    }
    this.workflow = workflow;
  }

  get(): MapItemWorkflow {
    if (this.workflow === undefined) {
      throw new Error('Map item workflow is not registered.');
    }
    return this.workflow;
  }
}
