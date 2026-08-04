import type { JsonValue } from '@revisium/revo-pipeline';

import type { ExecutionPlan } from '../../src/types.js';

type RunWorkflow = (executionPlan: ExecutionPlan, input: JsonValue) => Promise<unknown>;

const isRunWorkflow = (value: unknown): value is RunWorkflow => typeof value === 'function';

export class WorkflowRegistrationHarness {
  readonly registrations: string[];
  readonly workflows: Map<string, unknown>;

  constructor(registrations: string[], workflows: Map<string, unknown>) {
    this.registrations = registrations;
    this.workflows = workflows;
  }

  runWorkflow(): RunWorkflow {
    const workflow = this.workflows.get('revo-run.run.v2');
    if (!isRunWorkflow(workflow)) {
      throw new Error('v2 run workflow was not registered');
    }
    return workflow;
  }
}
