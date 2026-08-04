import type { JsonValue } from '../../src/types.js';

type TaskWorkflow = (runId: string, nodeKey: string, input: JsonValue) => Promise<unknown>;

const isTaskWorkflow = (value: unknown): value is TaskWorkflow => typeof value === 'function';

export class WorkflowRegistrationHarness {
  readonly registrations: string[];
  readonly workflows: Map<string, unknown>;

  constructor(registrations: string[], workflows: Map<string, unknown>) {
    this.registrations = registrations;
    this.workflows = workflows;
  }

  taskWorkflow(): TaskWorkflow {
    const workflow = this.workflows.get('revo-run.task.v1');
    if (!isTaskWorkflow(workflow)) {
      throw new Error('task workflow was not registered');
    }
    return workflow;
  }
}
