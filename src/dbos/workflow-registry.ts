import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutor } from '../contracts/executor/run-executor.js';
import { ParallelBranchWorkflowArgumentsParser } from '../validation/parallel-branch-workflow-input.validator.js';
import { RunExecutionWorkflowArgumentsParser } from '../validation/run-execution-workflow-input.validator.js';
import { RunWorkflowArgumentsParser } from '../validation/run-workflow.validator.js';
import {
  parallelBranchWorkflowName,
  runExecutionWorkflowName,
  runWorkflowName,
} from './dbos-names.js';
import { RunExecutorProvider } from './executor/run-executor-provider.js';
import { ParallelBranchWorkflowProvider } from './workflows/parallel-branch-workflow-provider.js';
import { createParallelBranchWorkflow } from './workflows/parallel-branch-workflow.js';
import {
  createRunExecutionWorkflow,
  type RunExecutionWorkflow,
} from './workflows/run-execution-workflow.js';
import { createRunWorkflow, type RunWorkflow } from './workflows/run-workflow.js';

export class WorkflowRegistry {
  readonly run: RunWorkflow;
  private readonly executor = new RunExecutorProvider();

  constructor() {
    const parallelBranchWorkflows = new ParallelBranchWorkflowProvider();
    parallelBranchWorkflows.register(
      DBOS.registerWorkflow(createParallelBranchWorkflow(this.executor, parallelBranchWorkflows), {
        name: parallelBranchWorkflowName,
        inputSchema: ParallelBranchWorkflowArgumentsParser,
      }),
    );
    const runExecutionWorkflow: RunExecutionWorkflow = DBOS.registerWorkflow(
      createRunExecutionWorkflow(this.executor, parallelBranchWorkflows),
      {
        name: runExecutionWorkflowName,
        inputSchema: RunExecutionWorkflowArgumentsParser,
      },
    );
    this.run = DBOS.registerWorkflow(createRunWorkflow(runExecutionWorkflow), {
      name: runWorkflowName,
      inputSchema: RunWorkflowArgumentsParser,
    });
  }

  bindExecutor(executor: RunExecutor): () => void {
    return this.executor.bind(executor);
  }
}
