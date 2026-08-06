import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutor } from '../contracts/executor/run-executor.js';
import { runWorkflowName } from './dbos-names.js';
import { RunExecutorProvider } from './executor/run-executor-provider.js';
import { createRunWorkflow, type RunWorkflow } from './workflows/run-workflow.js';

export class WorkflowRegistry {
  readonly run: RunWorkflow;
  private readonly executor = new RunExecutorProvider();

  constructor() {
    this.run = DBOS.registerWorkflow(createRunWorkflow(this.executor), {
      name: runWorkflowName,
    });
  }

  bindExecutor(executor: RunExecutor): () => void {
    return this.executor.bind(executor);
  }
}
