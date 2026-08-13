import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutor } from '../contracts/executor/run-executor.js';
import { ParallelBranchWorkflowArgumentsParser } from '../validation/parallel-branch-workflow-input.validator.js';
import { ParallelBranchWorkflowV2ArgumentsParser } from '../validation/parallel-branch-workflow-v2-input.validator.js';
import { CommandDispatchWorkflowArgumentsParser } from '../validation/run-command-workflow.validator.js';
import { RunExecutionWorkflowArgumentsParser } from '../validation/run-execution-workflow-input.validator.js';
import { RunWorkflowArgumentsParser } from '../validation/run-workflow.validator.js';
import { ScopeCancellationRegistry } from './coordination/scope-cancellation-registry.js';
import {
  parallelBranchWorkflowName,
  parallelBranchWorkflowV2Name,
  commandDispatchWorkflowName,
  runExecutionWorkflowName,
  runExecutionWorkflowV2Name,
  runWorkflowName,
  runWorkflowV2Name,
} from './dbos-names.js';
import { RunExecutorProvider } from './executor/run-executor-provider.js';
import {
  createCommandDispatchWorkflow,
  type CommandDispatchWorkflow,
} from './workflows/command-dispatch-workflow.js';
import { ParallelBranchWorkflowProvider } from './workflows/parallel-branch-workflow-provider.js';
import { ParallelBranchWorkflowV2Provider } from './workflows/parallel-branch-workflow-v2-provider.js';
import { createParallelBranchWorkflowV2 } from './workflows/parallel-branch-workflow-v2.js';
import { createParallelBranchWorkflow } from './workflows/parallel-branch-workflow.js';
import { createRunExecutionWorkflowV2 } from './workflows/run-execution-workflow-v2.js';
import {
  createRunExecutionWorkflow,
  type RunExecutionWorkflow,
} from './workflows/run-execution-workflow.js';
import { createRunWorkflowV2 } from './workflows/run-workflow-v2.js';
import { createRunWorkflow, type RunWorkflow } from './workflows/run-workflow.js';

export class WorkflowRegistry {
  readonly run: RunWorkflow;
  readonly runV1: RunWorkflow;
  readonly commandDispatch: CommandDispatchWorkflow;
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
    this.runV1 = DBOS.registerWorkflow(createRunWorkflow(runExecutionWorkflow), {
      name: runWorkflowName,
      inputSchema: RunWorkflowArgumentsParser,
    });

    const cancellation = new ScopeCancellationRegistry();
    const parallelBranchV2Workflows = new ParallelBranchWorkflowV2Provider();
    parallelBranchV2Workflows.register(
      DBOS.registerWorkflow(
        createParallelBranchWorkflowV2(this.executor, parallelBranchV2Workflows, cancellation),
        {
          name: parallelBranchWorkflowV2Name,
          inputSchema: ParallelBranchWorkflowV2ArgumentsParser,
        },
      ),
    );
    const runExecutionWorkflowV2 = DBOS.registerWorkflow(
      createRunExecutionWorkflowV2(this.executor, parallelBranchV2Workflows, cancellation),
      {
        name: runExecutionWorkflowV2Name,
        inputSchema: RunExecutionWorkflowArgumentsParser,
      },
    );
    this.run = DBOS.registerWorkflow(createRunWorkflowV2(runExecutionWorkflowV2, cancellation), {
      name: runWorkflowV2Name,
      inputSchema: RunWorkflowArgumentsParser,
    });
    this.commandDispatch = DBOS.registerWorkflow(createCommandDispatchWorkflow(), {
      name: commandDispatchWorkflowName,
      inputSchema: CommandDispatchWorkflowArgumentsParser,
    });
  }

  bindExecutor(executor: RunExecutor): () => void {
    return this.executor.bind(executor);
  }
}
