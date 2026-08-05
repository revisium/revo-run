import { DBOS } from '@dbos-inc/dbos-sdk';

import { runPipelineWorkflow } from '../execution/run-pipeline-workflow.js';

export type RegisteredRunWorkflow = typeof runPipelineWorkflow;

export class DbosWorkflowRegistry {
  readonly run: RegisteredRunWorkflow;

  constructor() {
    this.run = DBOS.registerWorkflow(runPipelineWorkflow, {
      name: 'revo-run.run.v1',
    });
  }
}
