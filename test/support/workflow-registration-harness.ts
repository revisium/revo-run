import type { JsonValue, RunSnapshot } from '../../src/types.js';

type TaskWorkflow = (runId: string, nodeKey: string, input: JsonValue) => Promise<unknown>;
type RunWorkflow = (snapshot: RunSnapshot) => Promise<RunSnapshot>;

const isTaskWorkflow = (value: unknown): value is TaskWorkflow => typeof value === 'function';
const isRunWorkflow = (value: unknown): value is RunWorkflow => typeof value === 'function';

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

  runWorkflow(): RunWorkflow {
    const workflow = this.workflows.get('revo-run.run.v1');
    if (!isRunWorkflow(workflow)) {
      throw new Error('run workflow was not registered');
    }
    return workflow;
  }
}
