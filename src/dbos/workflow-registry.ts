import { DBOS } from '@dbos-inc/dbos-sdk';

import type { RunExecutor } from '../contracts/executor/run-executor.js';
import { ParallelBranchWorkflowArgumentsParser } from '../validation/parallel-branch-workflow-input.validator.js';
import { RepeatIterationWorkflowArgumentsParser } from '../validation/repeat-iteration-workflow-input.validator.js';
import { CommandDispatchWorkflowArgumentsParser } from '../validation/run-command-workflow.validator.js';
import { RunExecutionWorkflowArgumentsParser } from '../validation/run-execution-workflow-input.validator.js';
import { RunWorkflowArgumentsParser } from '../validation/run-workflow.validator.js';
import { ScopeCancellationRegistry } from './coordination/scope-cancellation-registry.js';
import {
  commandDispatchWorkflowName,
  parallelBranchWorkflowName,
  repeatIterationWorkflowName,
  runExecutionWorkflowName,
  runWorkflowName,
} from './dbos-names.js';
import { ProviderCallRegistry } from './executor/provider-call-registry.js';
import { RunExecutorProvider } from './executor/run-executor-provider.js';
import {
  createCommandDispatchWorkflow,
  type CommandDispatchWorkflow,
} from './workflows/command-dispatch-workflow.js';
import { ParallelBranchWorkflowProvider } from './workflows/parallel-branch-workflow-provider.js';
import { createParallelBranchWorkflow } from './workflows/parallel-branch-workflow.js';
import { RepeatIterationWorkflowProvider } from './workflows/repeat-iteration-workflow-provider.js';
import { createRepeatIterationWorkflow } from './workflows/repeat-iteration-workflow.js';
import {
  createRunExecutionWorkflow,
  type RunExecutionWorkflow,
} from './workflows/run-execution-workflow.js';
import { createRunWorkflow, type RunWorkflow } from './workflows/run-workflow.js';

export class WorkflowRegistry {
  readonly run: RunWorkflow;
  readonly commandDispatch: CommandDispatchWorkflow;
  private readonly executor = new RunExecutorProvider();

  constructor() {
    const cancellation = new ScopeCancellationRegistry();
    const providerCalls = new ProviderCallRegistry();
    const parallelBranchWorkflows = new ParallelBranchWorkflowProvider();
    const repeatIterationWorkflows = new RepeatIterationWorkflowProvider();
    parallelBranchWorkflows.register(
      DBOS.registerWorkflow(
        createParallelBranchWorkflow(
          this.executor,
          parallelBranchWorkflows,
          repeatIterationWorkflows,
          cancellation,
          providerCalls,
        ),
        {
          name: parallelBranchWorkflowName,
          inputSchema: ParallelBranchWorkflowArgumentsParser,
        },
      ),
    );
    repeatIterationWorkflows.register(
      DBOS.registerWorkflow(
        createRepeatIterationWorkflow(
          this.executor,
          parallelBranchWorkflows,
          repeatIterationWorkflows,
          cancellation,
          providerCalls,
        ),
        {
          name: repeatIterationWorkflowName,
          inputSchema: RepeatIterationWorkflowArgumentsParser,
        },
      ),
    );
    const runExecutionWorkflow: RunExecutionWorkflow = DBOS.registerWorkflow(
      createRunExecutionWorkflow(
        this.executor,
        parallelBranchWorkflows,
        repeatIterationWorkflows,
        cancellation,
        providerCalls,
      ),
      {
        name: runExecutionWorkflowName,
        inputSchema: RunExecutionWorkflowArgumentsParser,
      },
    );
    this.run = DBOS.registerWorkflow(
      createRunWorkflow(runExecutionWorkflow, cancellation, providerCalls),
      {
        name: runWorkflowName,
        inputSchema: RunWorkflowArgumentsParser,
      },
    );
    this.commandDispatch = DBOS.registerWorkflow(createCommandDispatchWorkflow(), {
      name: commandDispatchWorkflowName,
      inputSchema: CommandDispatchWorkflowArgumentsParser,
    });
  }

  bindExecutor(executor: RunExecutor): () => void {
    return this.executor.bind(executor);
  }
}
